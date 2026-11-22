import { afterAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { findStepByName, parseWorkflow } from "./shared/workflow-contract";
import {
  createWorkflowStepRunner,
  type GhFixtures,
  workflowStepRepository as repository,
} from "./shared/workflow-step-runner";

const workflow = parseWorkflow(
  resolve(
    import.meta.dir,
    "../../../.github/workflows/workspace-e2e-pr-sync.yml"
  )
);
const flowsCli = resolve(
  import.meta.dir,
  "../../../.github/actions/workspace-e2e-flows/cli.mjs"
);
const syncJob = workflow.jobs["sync-pr-e2e-flows"];
const syncStep = findStepByName(
  workflow,
  "Sync Workspace E2E flows with PR description"
);

const prNumber = 42;
const headSha = "a".repeat(40);
const earlierSha = "b".repeat(40);
const headRef = "feat/example";
const previewUrl = "https://deskohub-workspace-site-abc123-team.vercel.app";

const { cleanup, runStep } = createWorkflowStepRunner("workspace-e2e-pr-sync-");
afterAll(cleanup);

const makePr = (body: string) => ({
  body,
  draft: false,
  head: {
    ref: headRef,
    repo: { full_name: repository },
    sha: headSha,
  },
  number: prNumber,
  state: "open",
  user: { login: "author" },
});

const deploymentFixtures = (
  statuses: readonly {
    readonly description: string;
    readonly environment_url?: string;
    readonly state: string;
  }[]
): GhFixtures => ({
  deployments: [{ creator: { login: "vercel[bot]" }, id: 11 }],
  "deployments/11/statuses": statuses,
});

const runSync = ({
  body,
  statuses = [],
  deployment = deploymentFixtures([
    {
      description: "Deployment has completed",
      environment_url: `${previewUrl}/`,
      state: "success",
    },
  ]),
  extraFixtures = {},
}: {
  readonly body: string;
  readonly statuses?: readonly object[];
  readonly deployment?: GhFixtures;
  readonly extraFixtures?: GhFixtures;
}) =>
  runStep(
    syncStep,
    {
      [`pulls/${prNumber}`]: makePr(body),
      [`commits/${headSha}/statuses`]: statuses,
      [`statuses/${headSha}`]: {},
      ...deployment,
      "": {},
      ...extraFixtures,
    },
    {
      FLOWS_CLI: flowsCli,
      PR_NUMBER: String(prNumber),
    }
  );

const statusPosts = (calls: readonly string[]) =>
  calls.filter((call) => call.includes(`/statuses/${headSha}`));

const workflowDispatches = (calls: readonly string[]) =>
  calls.filter((call) => call.startsWith("workflow run workspace-e2e.yml"));

describe("Workspace E2E PR flows sync workflow contract", () => {
  test("never checks out PR code and runs only for eligible internal PRs", () => {
    expect(workflow.permissions).toEqual({});
    expect(syncJob?.permissions).toEqual({
      actions: "write",
      contents: "read",
      deployments: "read",
      "pull-requests": "read",
      statuses: "write",
    });
    const checkouts = (syncJob?.steps ?? []).filter((step) =>
      (step.uses ?? "").startsWith("actions/checkout@")
    );
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]?.with?.ref).toContain("github.workflow_sha");
    expect(checkouts[0]?.with?.["persist-credentials"]).toBe(false);
    expect(checkouts[0]?.with?.["sparse-checkout"]).toBe(
      ".github/actions/workspace-e2e-flows"
    );

    const jobCondition = String(syncJob?.if);
    for (const guard of [
      "github.repository == 'totalolage/deskohub-site'",
      "github.event.pull_request.state == 'open'",
      "github.event.pull_request.draft == false",
      "github.event.pull_request.head.repo.full_name == github.repository",
      "github.event.pull_request.user.login != 'dependabot[bot]'",
      "!startsWith(github.event.pull_request.head.ref, 'dependabot/')",
    ]) {
      expect(jobCondition).toContain(guard);
    }
  });

  test.each([
    [
      "fork PR",
      {
        head: { ref: headRef, repo: { full_name: "fork/repo" }, sha: headSha },
      },
    ],
    ["draft PR", { draft: true }],
    ["Dependabot PR", { user: { login: "dependabot[bot]" } }],
  ])(
    "exits cleanly without posting statuses for an ineligible %s",
    async (_label, override) => {
      const { calls, result } = await runStep(
        syncStep,
        {
          [`pulls/${prNumber}`]: {
            ...makePr("## E2E flows\n- all\n"),
            ...override,
          },
        },
        {
          FLOWS_CLI: flowsCli,
          PR_NUMBER: String(prNumber),
        }
      );
      expect(result.exitCode).toBe(0);
      expect(statusPosts(calls)).toEqual([]);
      expect(workflowDispatches(calls)).toEqual([]);
    }
  );
});

describe("Workspace E2E PR flows sync step", () => {
  test("fails closed and marks Workspace E2E failed when ## E2E flows is missing or invalid", async () => {
    const { calls, result } = await runSync({
      body: "## Summary\nForgot E2E flows",
    });
    expect(result.exitCode).not.toBe(0);
    const posts = statusPosts(calls);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("state=failure");
    expect(posts[0]).toContain("Invalid or missing ## E2E flows");
    expect(workflowDispatches(calls)).toEqual([]);
  });

  test("marks Workspace E2E passed as skipped when PR declares none and preview succeeded", async () => {
    const { calls, result } = await runSync({
      body: "## E2E flows\n- `none`\n",
    });
    expect(result.exitCode).toBe(0);
    const posts = statusPosts(calls);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("state=success");
    expect(posts[0]).toContain("Protected preview E2E skipped [flows: none]");
    expect(workflowDispatches(calls)).toEqual([]);
  });

  test("never turns a failed deployment green even when PR declares none", async () => {
    const { calls, result } = await runSync({
      body: "## E2E flows\n- none\n",
      deployment: deploymentFixtures([
        { description: "Deployment has failed", state: "failure" },
      ]),
    });
    expect(result.exitCode).toBe(0);
    const posts = statusPosts(calls);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("state=failure");
    expect(posts[0]).toContain("Vercel preview deployment failed");
  });

  test("fails Workspace E2E and dispatches only newly added flows when PR body widens after a pass", async () => {
    const { calls, result } = await runSync({
      body: "## E2E flows\n- `admin`\n- `email-campaigns`\n",
      statuses: [
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description: "Protected preview E2E passed [flows: admin]",
          state: "success",
        },
      ],
    });
    expect(result.exitCode).toBe(0);
    const posts = statusPosts(calls);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("state=failure");
    const dispatches = workflowDispatches(calls);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toContain(`sha=${headSha}`);
    expect(dispatches[0]).toContain(`url=${previewUrl}`);
    expect(dispatches[0]).toContain(`ref=${headRef}`);
    expect(dispatches[0]).toContain("flows=email-campaigns");
  });

  test("does nothing when all requested flows already passed on this SHA", async () => {
    const { calls, result } = await runSync({
      body: "## E2E flows\n- `admin`\n",
      statuses: [
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description:
            "Protected preview E2E passed [flows: admin,email-campaigns]",
          state: "success",
        },
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(statusPosts(calls)).toEqual([]);
    expect(workflowDispatches(calls)).toEqual([]);
  });

  test("does not cancel or re-dispatch when an in-progress run already covers the requested flows", async () => {
    const { calls, result } = await runSync({
      body: "## E2E flows\n- `admin`\n",
      statuses: [
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description: "Protected preview E2E is running [flows: admin]",
          state: "pending",
        },
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(statusPosts(calls)).toEqual([]);
    expect(workflowDispatches(calls)).toEqual([]);
  });

  test("fails and dispatches full unpassed flow list when a new flow is added mid-run", async () => {
    const { calls, result } = await runSync({
      body: "## E2E flows\n- `admin`\n- `email-campaigns`\n",
      statuses: [
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description: "Protected preview E2E is running [flows: admin]",
          state: "pending",
        },
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(statusPosts(calls)).toHaveLength(1);
    expect(statusPosts(calls)[0]).toContain("state=failure");
    const dispatches = workflowDispatches(calls);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toContain("flows=admin,email-campaigns");
  });

  test("fails a skipped deployment when same-tree commit only passed a subset", async () => {
    const { calls, result } = await runSync({
      body: "## E2E flows\n- `admin`\n- `email-campaigns`\n",
      deployment: deploymentFixtures([
        { description: "Skipped - Not affected", state: "inactive" },
      ]),
      extraFixtures: {
        [`pulls/${prNumber}/commits`]: [
          { commit: { tree: { sha: "tree-1" } }, sha: earlierSha },
          { commit: { tree: { sha: "tree-1" } }, sha: headSha },
        ],
        [`commits/${earlierSha}/statuses`]: [
          {
            context: "Workspace E2E",
            creator: { login: "github-actions[bot]" },
            description: "Protected preview E2E passed [flows: admin]",
            state: "success",
          },
        ],
      },
    });
    expect(result.exitCode).toBe(0);
    expect(statusPosts(calls)).toHaveLength(1);
    expect(statusPosts(calls)[0]).toContain("state=failure");
    expect(statusPosts(calls)[0]).toContain("lacks required E2E flows");
    expect(workflowDispatches(calls)).toEqual([]);
  });
});
