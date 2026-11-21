import { expect, test } from "bun:test";
import { githubIssueTracker } from "./github";
import { nightlyRunMarker } from "./nightly-evidence";

const report =
  "<!-- issue-pool-source:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->";
const worker = "<!-- t3-worker-thread:worker-id -->";
const reporter = { id: 101, login: "pool-reporter" };
const maintainer = { id: 102, login: "maintainer" };
const outsider = { id: 800, login: "pool-reporter" };
const defaults = {
  repo: "owner/repository",
  reporterId: reporter.id,
  maintainerId: maintainer.id,
  legacyFeedbackClaimed: () => false,
};
const restIssue = {
  number: 32,
  state: "open",
  created_at: "2026-11-21T10:00:00Z",
  closed_at: null,
  body: report,
  assignees: [],
  labels: [{ name: "issue-pool" }],
};

const ownership = (
  author: number,
  state = "MERGED",
  body = report,
  issueState = "OPEN"
) =>
  JSON.stringify({
    data: {
      repository: {
        issue: {
          state: issueState,
          body,
          author: { databaseId: author },
          assignees: { totalCount: 0 },
          closedByPullRequestsReferences: { nodes: [{ state }] },
        },
      },
    },
  });

test("ignores forged collector markers and labels on issues from untrusted authors", async () => {
  const tracker = githubIssueTracker({
    ...defaults,
    async run() {
      return JSON.stringify([
        [
          { ...restIssue, user: reporter },
          { ...restIssue, number: 33, user: maintainer, body: "Manual issue" },
          { ...restIssue, number: 34, user: outsider },
          { ...restIssue, number: 35, user: null },
        ],
      ]);
    },
  });

  const issues = await tracker.list();
  expect(issues.map(({ number }) => number)).toEqual([32, 33]);
  expect(issues[0]?.body).toBe(report);
  expect(issues[1]?.labels).toEqual(["issue-pool"]);
});

test("refreshes ownership after reading replies and ignores outsider worker markers", async () => {
  let markerAuthor = outsider;
  let issueAuthor = reporter.id;
  let prState = "MERGED";
  const tracker = githubIssueTracker({
    ...defaults,
    async run(_executable, args) {
      return args.includes("graphql")
        ? ownership(issueAuthor, prState)
        : JSON.stringify([[{ id: 1, body: worker, user: markerAuthor }]]);
    },
  });

  expect(await tracker.pendingReply(32)).toBeNull();
  expect(await tracker.hasOwner(32)).toBe(false);
  markerAuthor = reporter;
  expect(await tracker.hasOwner(32)).toBe(true);
  markerAuthor = outsider;
  prState = "OPEN";
  expect(await tracker.hasOwner(32)).toBe(true);
  prState = "MERGED";
  issueAuthor = outsider.id;
  expect(await tracker.hasOwner(32)).toBe(true);
});

test("checks the authenticated author of a newly filed issue", async () => {
  const tracker = githubIssueTracker({
    ...defaults,
    async run() {
      return JSON.stringify({ ...restIssue, user: outsider });
    },
  });
  let failure: unknown;
  try {
    await tracker.file("Run failed", report);
  } catch (error) {
    failure = error;
  }
  expect(failure).toEqual(
    new Error("Created issue did not have the authenticated author")
  );
});

test("treats a trusted closed issue with a merged closing PR as completed work", async () => {
  let issueState = "OPEN";
  let pullState = "OPEN";
  const tracker = githubIssueTracker({
    ...defaults,
    async run(_executable, args) {
      return args.includes("graphql")
        ? ownership(maintainer.id, pullState, report, issueState)
        : "[[]]";
    },
  });
  expect(await tracker.hasOwner(32)).toBe(true);
  expect(await tracker.hasClosedWork(32)).toBe(false);
  issueState = "CLOSED";
  pullState = "MERGED";
  expect(await tracker.hasClosedWork(32)).toBe(true);
  pullState = "CLOSED";
  expect(await tracker.hasClosedWork(32)).toBe(false);
});

test("routes the first later reply from the maintainer and respects trusted dispositions", async () => {
  const rows = [
    { id: 1, user: reporter, body: worker },
    { id: 2, user: reporter, body: "<!-- posthog-agent:human-needed -->" },
    { id: 3, user: maintainer, body: "An older answer" },
    {
      id: 4,
      user: reporter,
      body: "New question\n<!-- posthog-agent:human-needed -->",
    },
    {
      id: 5,
      user: outsider,
      body: "<!-- posthog-agent:triage-non-actionable -->",
    },
    { id: 6, user: outsider, body: "An outside comment" },
    { id: 7, user: maintainer, body: "The answer" },
  ];
  const tracker = () =>
    githubIssueTracker({
      ...defaults,
      async run(_executable, args) {
        return args.includes("graphql")
          ? ownership(maintainer.id)
          : JSON.stringify([rows]);
      },
    });
  expect(await tracker().suppressesRecurrence(32)).toBe(false);
  expect(await tracker().pendingReply(32)).toEqual({
    commentId: 7,
    threadId: "worker-id",
    message: "The answer",
  });
  rows.push({
    id: 8,
    user: reporter,
    body: "<!-- posthog-agent:consumed-comment:7 -->",
  });
  rows.push({
    id: 9,
    user: reporter,
    body: "<!-- posthog-agent:triage-non-actionable -->",
  });
  expect(await tracker().pendingReply(32)).toBeNull();
  expect(await tracker().suppressesRecurrence(32)).toBe(true);
});

test("appends only previously unrecorded nightly runs and ignores forged evidence comments", async () => {
  const first =
    "https://github.com/owner/repository/actions/runs/101/attempts/1";
  const later =
    "https://github.com/owner/repository/actions/runs/102/attempts/1";
  const comments = [{ id: 100, user: outsider, body: nightlyRunMarker(later) }];
  const updates: string[] = [];
  const tracker = githubIssueTracker({
    ...defaults,
    async run(_executable, args, input) {
      if (args.includes("graphql")) return ownership(reporter.id);
      if (args.includes("POST")) {
        const { body }: { body: string } = JSON.parse(input ?? "");
        comments.push({ id: 101, user: reporter, body });
        updates.push(body);
        return "{}";
      }
      return JSON.stringify([comments]);
    },
  });
  const issue = {
    number: 32,
    state: "open",
    createdAt: "2026-11-21T10:00:00Z",
    closedAt: null,
    body: nightlyRunMarker(first),
    labels: [],
    assignees: [],
  } as const;
  await tracker.recordNightlyRuns(issue, [first, later]);
  await tracker.recordNightlyRuns(issue, [first, later]);
  expect(updates).toHaveLength(1);
  expect(updates[0]).toContain(nightlyRunMarker(later));
  expect(updates[0]).not.toContain(nightlyRunMarker(first));
});

test("does not treat an automated evidence comment from the maintainer account as an answer", async () => {
  const automatedEvidence = nightlyRunMarker(
    "https://github.com/owner/repository/actions/runs/101/attempts/1"
  );
  const comments = [
    { id: 1, user: maintainer, body: worker },
    {
      id: 2,
      user: maintainer,
      body: "Question\n<!-- posthog-agent:human-needed -->",
    },
    { id: 3, user: maintainer, body: automatedEvidence },
    { id: 4, user: maintainer, body: "Human answer" },
  ];
  const tracker = githubIssueTracker({
    ...defaults,
    reporterId: maintainer.id,
    async run(_executable, args) {
      return args.includes("graphql")
        ? ownership(maintainer.id)
        : JSON.stringify([comments]);
    },
  });
  expect(await tracker.pendingReply(32)).toEqual({
    commentId: 4,
    message: "Human answer",
    threadId: "worker-id",
  });
});
