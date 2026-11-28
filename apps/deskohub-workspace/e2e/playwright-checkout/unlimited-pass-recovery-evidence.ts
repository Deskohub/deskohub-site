import { asRecord } from "../artifact-sanitization";
import { addRedaction } from "../redaction";

export const originalUnlimitedRun = {
  id: "45856799102",
  attempt: 1,
  sha: "2925bbac552915e953b93b34e334f8b68d50d6a4",
  branch: "feat/unlimited-membership-checkout",
  repository: "totalolage/deskohub-site",
  startedAt: "2026-11-26T16:14:29Z",
  completedAt: "2026-11-26T16:20:38Z",
} as const;

const project = "prj_7FliQBcbBiBwGaO2JLrigicnXCRd";
const team = "team_MgMQ4MEWijWnYa1R48C2JU5e";
const sandboxHost = "xpaysandbox.nexigroup.com";

export class UnlimitedRecoveryEvidenceRejected extends Error {}

export function requireRecovery(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) throw new UnlimitedRecoveryEvidenceRejected(message);
}

const record = (value: unknown) => asRecord(value) ?? {};
const records = (value: unknown) =>
  Array.isArray(value) ? value.map(record) : [];

export function verifyOriginalUnlimitedRun(
  run: unknown,
  workflowJobs: unknown
) {
  const source = record(run);
  requireRecovery(
    String(source.id) === originalUnlimitedRun.id &&
      source.run_attempt === originalUnlimitedRun.attempt &&
      source.head_sha === originalUnlimitedRun.sha &&
      source.head_branch === originalUnlimitedRun.branch &&
      source.event === "workflow_dispatch" &&
      source.path === ".github/workflows/workspace-e2e.yml" &&
      source.status === "completed" &&
      source.conclusion === "failure" &&
      record(source.head_repository).full_name ===
        originalUnlimitedRun.repository,
    "Original Unlimited workflow identity did not match"
  );
  const jobs = records(record(workflowJobs).jobs).filter(
    ({ name }) => name === "test-e2e"
  );
  const [job] = jobs;
  requireRecovery(
    jobs.length === 1 &&
      job?.started_at === originalUnlimitedRun.startedAt &&
      job.completed_at === originalUnlimitedRun.completedAt &&
      job.conclusion === "failure" &&
      records(job.steps).some(
        ({ name, conclusion }) =>
          name === "Lease an available date shard" && conclusion === "success"
      ) &&
      records(job.steps).some(
        ({ name, conclusion }) =>
          name === "Release date shard" && conclusion === "success"
      ),
    "Original Unlimited checkout job or allocation did not match"
  );
}

const isExplicitZero = (value: unknown) =>
  typeof value === "string" && /^0+(?:\.0+)?$/.test(value);

export function classifyUnlimitedRecoveryPayment<
  Attempt extends {
    readonly id: string;
    readonly provider: string;
    readonly state: string;
    readonly failureCode: string | null;
    readonly lastProviderStatus: string | null;
  },
>(input: {
  readonly paymentState: string;
  readonly purchaseState: string;
  readonly activeAttemptId: string | null;
  readonly attempts: readonly Attempt[];
}) {
  const [attempt] = input.attempts;
  requireRecovery(
    input.attempts.length === 1 &&
      attempt?.provider === "nexi" &&
      input.activeAttemptId === attempt.id,
    "Recovery attempt ownership is ambiguous"
  );
  if (
    input.paymentState === "pending" &&
    input.purchaseState === "pending_payment" &&
    attempt.state === "pending"
  )
    return { state: "pending" as const, attempt };
  requireRecovery(
    input.paymentState === "cancelled" &&
      input.purchaseState === "void" &&
      attempt.state === "cancelled" &&
      attempt.failureCode === "nexi_payment_failed" &&
      attempt.lastProviderStatus === "CANCELED",
    "Recovery payment state was not provider-cancelled"
  );
  return { state: "cancelled" as const, attempt };
}

export function verifyUnlimitedRecoveryBuyer(input: {
  readonly tombstoned: boolean;
  readonly linkedCustomerId: string | null;
  readonly authEmail: string | null;
  readonly customerId: string;
  readonly recipient: string;
}) {
  requireRecovery(
    input.tombstoned
      ? input.linkedCustomerId === null &&
          (input.authEmail === null || input.authEmail === input.recipient)
      : input.linkedCustomerId === input.customerId &&
          input.authEmail === input.recipient,
    "Recovery buyer identity did not match"
  );
  return {
    removeLogin: input.authEmail !== null,
    expireProfile: !input.tombstoned,
  };
}

export function verifyCancelledUnlimitedNexiOrder(
  response: unknown,
  expected: { readonly orderId: string; readonly amount: number }
) {
  const body = record(response);
  const status = record(body.orderStatus);
  const order = record(status.order);
  const operations = records(body.operations);
  const [operation] = operations;
  requireRecovery(
    order.orderId === expected.orderId &&
      (body.orderId === undefined || body.orderId === expected.orderId) &&
      order.currency === "EUR" &&
      order.amount === String(expected.amount) &&
      isExplicitZero(status.authorizedAmount) &&
      isExplicitZero(status.capturedAmount) &&
      operations.length === 1 &&
      operation?.operationType === "AUTHORIZATION" &&
      operation.operationResult === "CANCELED" &&
      typeof operation.operationId === "string" &&
      operation.operationId.length > 0,
    "Nexi did not confirm the exact cancelled zero-money attempt"
  );
  return operation.operationId;
}

async function getJson(url: URL, headers: HeadersInit): Promise<unknown> {
  const response = await fetch(url, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  requireRecovery(response.ok, "Recovery evidence request failed");
  return response.json();
}

export async function checkRecoveryDeployment(input: {
  readonly githubToken: string;
  readonly currentRun: string;
  readonly currentAttempt: number;
  readonly preview: string;
  readonly sha: string;
  readonly vercelToken: string;
}) {
  addRedaction(input.githubToken, true);
  addRedaction(input.vercelToken, true);
  const github = { Authorization: `Bearer ${input.githubToken}` };
  requireRecovery(
    /^[0-9]+$/.test(input.currentRun) &&
      input.currentRun !== originalUnlimitedRun.id &&
      Number.isSafeInteger(input.currentAttempt) &&
      input.currentAttempt > 0,
    "Recovery requires an active workflow attempt"
  );
  const current = `https://api.github.com/repos/${originalUnlimitedRun.repository}/actions/runs/${input.currentRun}`;
  const currentRun = record(await getJson(new URL(current), github));
  const currentJobs = records(
    record(
      await getJson(
        new URL(`${current}/attempts/${input.currentAttempt}/jobs`),
        github
      )
    ).jobs
  ).filter(({ name }) => name === "test-e2e");
  requireRecovery(
    currentRun.event === "workflow_dispatch" &&
      currentRun.head_sha === input.sha &&
      currentRun.head_branch === originalUnlimitedRun.branch &&
      currentRun.run_attempt === input.currentAttempt &&
      currentRun.status === "in_progress" &&
      currentJobs.length === 1 &&
      currentJobs[0]?.status === "in_progress" &&
      records(currentJobs[0].steps).some(
        ({ name, conclusion }) =>
          name === "Lease an available date shard" && conclusion === "success"
      ) &&
      !records(currentJobs[0].steps).some(
        ({ name, status }) =>
          name === "Release date shard" &&
          ["in_progress", "completed"].includes(String(status))
      ),
    "The exact recovery workflow did not hold its normal allocation"
  );
  const api = `https://api.github.com/repos/${originalUnlimitedRun.repository}/actions/runs/${originalUnlimitedRun.id}`;
  verifyOriginalUnlimitedRun(
    await getJson(new URL(api), github),
    await getJson(new URL(`${api}/attempts/1/jobs`), github)
  );
  const pull = record(
    await getJson(
      new URL(
        `https://api.github.com/repos/${originalUnlimitedRun.repository}/pulls/1527`
      ),
      github
    )
  );
  const head = record(pull.head);
  requireRecovery(
    pull.state === "open" &&
      pull.draft === true &&
      head.sha === input.sha &&
      head.ref === originalUnlimitedRun.branch &&
      record(head.repo).full_name === originalUnlimitedRun.repository,
    "Recovery target is no longer the exact internal draft"
  );
  const url = new URL(input.preview);
  requireRecovery(
    url.origin === input.preview &&
      /^deskohub-workspace-site-[a-z0-9]+-filip-kalny-projects\.vercel\.app$/.test(
        url.hostname
      ) &&
      url.protocol === "https:",
    "Recovery requires the immutable Workspace Git Preview"
  );
  const deployment = record(
    await getJson(
      new URL(
        `https://api.vercel.com/v13/deployments/${url.hostname}?teamId=${team}`
      ),
      { Authorization: `Bearer ${input.vercelToken}` }
    )
  );
  const meta = record(deployment.meta);
  requireRecovery(
    deployment.projectId === project &&
      deployment.target === null &&
      deployment.readyState === "READY" &&
      meta.githubCommitRef === originalUnlimitedRun.branch &&
      meta.githubCommitSha === input.sha,
    "Recovery Preview provenance did not match"
  );
}

export async function readCancelledUnlimitedNexiAttempt(input: {
  readonly providerOrderId: string;
  readonly amount: number;
  readonly vercelToken: string;
}) {
  requireRecovery(
    /^D[A-Z0-9]+$/.test(input.providerOrderId),
    "Invalid sandbox order identity"
  );
  addRedaction(input.providerOrderId);
  const vercel = { Authorization: `Bearer ${input.vercelToken}` };
  const env = `https://api.vercel.com/v9/projects/${project}/env`;
  const variables = records(
    record(await getJson(new URL(`${env}?teamId=${team}`), vercel)).envs
  );
  const matches = variables.filter(
    (entry) =>
      entry.key === "NEXI_API_KEY" &&
      Array.isArray(entry.target) &&
      entry.target.includes("preview") &&
      (!entry.gitBranch || entry.gitBranch === originalUnlimitedRun.branch)
  );
  const [key] = matches;
  requireRecovery(
    matches.length === 1 &&
      typeof key?.id === "string" &&
      /^[A-Za-z0-9_]+$/.test(key.id) &&
      key.type === "encrypted" &&
      Array.isArray(key.target) &&
      !key.target.includes("production"),
    "The exact sandbox-only Preview Nexi credential could not be identified"
  );
  const credential = record(
    await getJson(
      new URL(
        `https://api.vercel.com/v1/projects/${project}/env/${key.id}?teamId=${team}`
      ),
      vercel
    )
  ).value;
  requireRecovery(
    typeof credential === "string" && credential.length > 0,
    "The sandbox Nexi credential is unavailable"
  );
  addRedaction(credential, true);
  const response = await getJson(
    new URL(
      `https://${sandboxHost}/api/phoenix-0.0/psp/api/v1/orders/${input.providerOrderId}`
    ),
    { "X-API-KEY": credential, "Correlation-Id": crypto.randomUUID() }
  );
  return verifyCancelledUnlimitedNexiOrder(response, {
    orderId: input.providerOrderId,
    amount: input.amount,
  });
}
