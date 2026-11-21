import { expect, test } from "bun:test";
import { githubIssueTracker } from "./github";

const report = "<!-- posthog-log-uuid:event-id -->";
const worker = "<!-- t3-worker-thread:worker-id -->";
const restIssue = {
  number: 32,
  state: "open",
  closed_at: null,
  body: report,
  assignees: [],
  labels: [],
};

test("accepts collector markers only from trusted reporters and preserves human enrollment labels", async () => {
  const tracker = githubIssueTracker({
    repo: "owner/repository",
    trustedReporters: ["internal-reporter"],
    legacyFeedbackClaimed: () => false,
    async run() {
      return JSON.stringify([
        [
          { ...restIssue, user: { login: "internal-reporter" } },
          {
            ...restIssue,
            number: 33,
            user: { login: "external-author" },
            labels: [{ name: "issue-pool" }],
          },
        ],
      ]);
    },
  });

  const [internal, external] = await tracker.list();
  expect(internal?.body).toBe(report);
  expect(external?.body).toBe("");
  expect(external?.labels).toEqual(["issue-pool"]);
});

test("checks fresh issue ownership and ignores worker markers posted by outsiders", async () => {
  let markerAuthor = "external-author";
  let prState = "MERGED";
  const tracker = () =>
    githubIssueTracker({
      repo: "owner/repository",
      trustedReporters: ["internal-reporter"],
      legacyFeedbackClaimed: () => false,
      async run(_executable, args) {
        if (args.includes("graphql")) {
          return JSON.stringify({
            data: {
              repository: {
                issue: {
                  state: "OPEN",
                  body: report,
                  author: { login: "internal-reporter" },
                  assignees: { totalCount: 0 },
                  closedByPullRequestsReferences: {
                    nodes: [{ state: prState }],
                  },
                },
              },
            },
          });
        }
        return JSON.stringify([
          [{ id: 1, body: worker, user: { login: markerAuthor } }],
        ]);
      },
    });

  expect(await tracker().hasOwner(32)).toBe(false);
  markerAuthor = "internal-reporter";
  expect(await tracker().hasOwner(32)).toBe(true);
  markerAuthor = "external-author";
  prState = "OPEN";
  expect(await tracker().hasOwner(32)).toBe(true);
});

test("routes the first later reply from the maintainer and respects trusted dispositions", async () => {
  const maintainer = { login: "totalolage" };
  const automation = { login: "pool-bot" };
  const outsider = { login: "external-author" };
  const rows = [
    { id: 1, user: automation, body: worker },
    { id: 2, user: automation, body: "<!-- posthog-agent:human-needed -->" },
    { id: 3, user: maintainer, body: "An older answer" },
    {
      id: 4,
      user: automation,
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
      repo: "owner/repository",
      trustedReporters: [maintainer.login, automation.login],
      legacyFeedbackClaimed: () => false,
      async run(_executable, args) {
        return args.includes("graphql")
          ? JSON.stringify({
              data: { repository: { issue: { state: "OPEN" } } },
            })
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
    user: automation,
    body: "<!-- posthog-agent:consumed-comment:7 -->",
  });
  rows.push({
    id: 9,
    user: automation,
    body: "<!-- posthog-agent:triage-non-actionable -->",
  });
  expect(await tracker().pendingReply(32)).toBeNull();
  expect(await tracker().suppressesRecurrence(32)).toBe(true);
});
