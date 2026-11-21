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
    legacyVercelReported: () => false,
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
  const tracker = githubIssueTracker({
    repo: "owner/repository",
    trustedReporters: ["internal-reporter"],
    legacyVercelReported: () => false,
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
                closedByPullRequestsReferences: { nodes: [{ state: prState }] },
              },
            },
          },
        });
      }
      return JSON.stringify([
        [{ body: worker, user: { login: markerAuthor } }],
      ]);
    },
  });

  expect(await tracker.hasOwner(32)).toBe(false);
  markerAuthor = "internal-reporter";
  expect(await tracker.hasOwner(32)).toBe(true);
  markerAuthor = "external-author";
  prState = "OPEN";
  expect(await tracker.hasOwner(32)).toBe(true);
});
