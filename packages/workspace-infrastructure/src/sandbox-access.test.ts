import { describe, expect, test } from "bun:test";
import { sandboxServiceAccount } from "./config/stack-config.test-utils";

const workflowFile = new URL(
  "../../../.github/workflows/workspace-gcp-sandbox-smoke.yml",
  import.meta.url
);
const bootstrapScript = new URL(
  "../scripts/bootstrap-sandbox-wif.sh",
  import.meta.url
).pathname;

interface WorkflowStep {
  readonly uses?: string;
  readonly with?: Record<string, string>;
  readonly run?: string;
}
interface Workflow {
  readonly on: Record<string, unknown>;
  readonly permissions: Record<string, string>;
  readonly jobs: Record<
    string,
    {
      readonly environment: string;
      readonly permissions: Record<string, string>;
      readonly env: Record<string, string>;
      readonly steps: ReadonlyArray<WorkflowStep>;
    }
  >;
}

const workflow = Bun.YAML.parse(
  await Bun.file(workflowFile).text()
) as Workflow;

const runBootstrap = (...args: ReadonlyArray<string>) =>
  Bun.spawnSync(["bash", bootstrapScript, ...args], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });

const dryRunArgs = [
  "--dry-run",
  "--project-id",
  "deskohub-ws-sandbox",
  "--project-number",
  "123456789012",
  "--github-repository",
  "example-owner/example-repo",
  "--github-owner-id",
  "1001",
  "--github-repository-id",
  "2002",
  "--max-spend",
  "200",
  "--currency",
  "EUR",
  "--teardown-date",
  "2026-12-31",
];

describe("sandbox smoke workflow", () => {
  test("runs only on manual dispatch", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  test("grants id-token only to the smoke job in the sandbox environment", () => {
    expect(Object.keys(workflow.jobs)).toEqual(["smoke"]);
    const job = workflow.jobs.smoke;
    expect(job?.environment).toBe("workspace-gcp-sandbox");
    expect(job?.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(Object.keys(job?.env ?? {})).toEqual([
      "GCP_SANDBOX_PROJECT_ID",
      "GCP_SANDBOX_WIF_PROVIDER",
      "GCP_SANDBOX_DEPLOY_SA",
      "GCP_SANDBOX_STATE_BUCKET",
    ]);
  });

  test("pins every action by full commit SHA and authenticates through federation", () => {
    const steps = workflow.jobs.smoke?.steps ?? [];
    const actions = steps.flatMap((step) => (step.uses ? [step.uses] : []));
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(action).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    }
    const auth = steps.find((step) =>
      step.uses?.startsWith("google-github-actions/auth@")
    );
    const variable = (name: string) => ["${{", `vars.${name}`, "}}"].join(" ");
    expect(auth?.with).toEqual({
      project_id: variable("GCP_SANDBOX_PROJECT_ID"),
      workload_identity_provider: variable("GCP_SANDBOX_WIF_PROVIDER"),
      service_account: variable("GCP_SANDBOX_DEPLOY_SA"),
    });
  });

  test("runs read-only checks without expanding expressions in scripts", () => {
    const scripts = (workflow.jobs.smoke?.steps ?? [])
      .flatMap((step) => (step.run ? [step.run] : []))
      .join("\n");
    expect(scripts).not.toContain("${{");
    for (const check of [
      "gcloud projects describe",
      "gcloud billing projects describe",
      "gcloud storage buckets describe",
    ]) {
      expect(scripts).toContain(check);
    }
    const gcloudCommands = [
      ...scripts.matchAll(/gcloud ([a-z -]+?)(?= ["-])/g),
    ].map((match) => match[1]);
    expect(new Set(gcloudCommands)).toEqual(
      new Set([
        "auth list",
        "projects describe",
        "billing projects describe",
        "storage buckets describe",
        "storage ls",
      ])
    );
  });
});

describe("sandbox bootstrap script", () => {
  test("passes bash -n", () => {
    const result = Bun.spawnSync(["bash", "-n", bootstrapScript]);
    expect(result.exitCode).toBe(0);
  });

  test("rejects a non-numeric GitHub repository ID", () => {
    const args = [...dryRunArgs];
    args[args.indexOf("2002")] = "example-repo";
    const result = runBootstrap(...args);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("--github-repository-id");
  });

  test("restricts federation to the trusted workflow, environment and IDs", () => {
    const result = runBootstrap(...dryRunArgs);
    const output = result.stdout.toString();
    expect(result.exitCode).toBe(0);
    expect(output).toContain(
      "assertion.repository_owner_id\\ ==\\ \\'1001\\'\\ \\&\\&\\ assertion.repository_id\\ ==\\ \\'2002\\'\\ \\&\\&\\ assertion.environment\\ ==\\ \\'workspace-gcp-sandbox\\'\\ \\&\\&\\ assertion.workflow_ref\\ ==\\ \\'example-owner/example-repo/.github/workflows/workspace-gcp-sandbox-smoke.yml@refs/heads/main\\'"
    );
    expect(output).toContain(
      "--role roles/iam.workloadIdentityUser --format=none --member principal://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/github-actions/subject/repo:example-owner/example-repo:environment:workspace-gcp-sandbox"
    );
    for (const account of [
      "workspace-deployer",
      "workspace-web",
      "workspace-tasks-worker",
      "workspace-scheduler-worker",
      "workspace-tasks-invoker",
      "workspace-scheduler-invoker",
    ]) {
      expect(output).toContain(
        `gcloud iam service-accounts create ${account} `
      );
    }
    expect(output).not.toMatch(
      /roles\/(?:owner|editor|iam\.securityAdmin|resourcemanager\.projectIamAdmin|secretmanager\.(?:admin|secretAccessor))\b/
    );
    expect(output).toContain(
      "gcloud storage buckets update gs://deskohub-ws-sandbox-workspace-state --versioning"
    );
  });

  test("prints the gh variable commands and no secret values", () => {
    const output = runBootstrap(...dryRunArgs).stdout.toString();
    const ghCommands = output
      .split("\n")
      .filter((line) => line.startsWith("gh variable set"));
    expect(ghCommands).toEqual([
      "gh variable set GCP_SANDBOX_PROJECT_ID --repo example-owner/example-repo --env workspace-gcp-sandbox --body deskohub-ws-sandbox",
      "gh variable set GCP_SANDBOX_WIF_PROVIDER --repo example-owner/example-repo --env workspace-gcp-sandbox --body projects/123456789012/locations/global/workloadIdentityPools/github-actions/providers/deskohub-workspace",
      `gh variable set GCP_SANDBOX_DEPLOY_SA --repo example-owner/example-repo --env workspace-gcp-sandbox --body ${sandboxServiceAccount("workspace-deployer")}`,
      "gh variable set GCP_SANDBOX_STATE_BUCKET --repo example-owner/example-repo --env workspace-gcp-sandbox --body deskohub-ws-sandbox-workspace-state",
    ]);
    expect(output).not.toMatch(
      /gh secret|service-accounts keys|versions add|--data-file/
    );
    expect(Object.keys(workflow.jobs.smoke?.env ?? {})).toEqual(
      ghCommands.map((line) => line.split(" ")[3] ?? "")
    );
  });
});
