import * as Effect from "effect/Effect";
import {
  decodeWorkspaceStackConfig,
  SandboxStackConfig,
  serializeWorkspaceStackConfig,
} from "../src/config/stack-config";

/** The approved identifiers of the disposable sandbox the proof runs in. */
export interface SandboxProofIdentity {
  readonly projectId: string;
  readonly projectNumber: string;
  readonly region: string;
  readonly stateBucket: string;
  /** The pushed collector image digest, once the images phase ran. */
  readonly telemetryCollectorImage?: string;
  /** The proof run's disposable queue ID suffix, once foundation ran. */
  readonly disposableQueueSuffix?: string;
}

/** The approved gross cap and teardown of the sandbox proof (#1452). */
export const sandboxProofBudget = {
  currency: "CZK",
  maximumSpend: 500,
  teardownAt: "2026-11-30T23:59:59Z",
} as const;

/** Whether the stack config schema declares the collector sidecar image. */
export const stackConfigDeclaresTelemetryCollector =
  "telemetryCollectorImage" in SandboxStackConfig.fields;

const serviceAccount = (projectId: string, name: string) =>
  [name, `${projectId}.iam.gserviceaccount.com`].join("@");

/**
 * The sandbox stack config input: the accounts the bootstrap script
 * creates, no secrets, single-instance capacity and paused schedules.
 */
export const sandboxProofStackConfigInput = (
  identity: SandboxProofIdentity
) => ({
  stage: "sandbox",
  projectId: identity.projectId,
  projectNumber: identity.projectNumber,
  region: identity.region,
  stateBucket: identity.stateBucket,
  mobileUpdatesBucket: `${identity.projectId}-mobile-updates`,
  serviceAccounts: {
    deployer: serviceAccount(identity.projectId, "workspace-deployer"),
    webRuntime: serviceAccount(identity.projectId, "workspace-web"),
    tasksWorkerRuntime: serviceAccount(
      identity.projectId,
      "workspace-tasks-worker"
    ),
    schedulerWorkerRuntime: serviceAccount(
      identity.projectId,
      "workspace-scheduler-worker"
    ),
    tasksInvoker: serviceAccount(identity.projectId, "workspace-tasks-invoker"),
    schedulerInvoker: serviceAccount(
      identity.projectId,
      "workspace-scheduler-invoker"
    ),
    mobileUpdatesPublisher: serviceAccount(
      identity.projectId,
      "workspace-mobile-publisher"
    ),
  },
  secrets: [],
  capacity: {
    webMaxInstances: 1,
    workerMaxInstances: 1,
    queueMaxConcurrentDispatches: 1,
    queueMaxDispatchesPerSecond: 1,
  },
  schedulesEnabled: false,
  alertNotificationChannels: [],
  budget: sandboxProofBudget,
  ...(identity.telemetryCollectorImage === undefined
    ? {}
    : { telemetryCollectorImage: identity.telemetryCollectorImage }),
  ...(identity.disposableQueueSuffix === undefined
    ? {}
    : { disposableQueueSuffix: identity.disposableQueueSuffix }),
});

/** Build and decode the config with the package schema; returns its JSON. */
export const sandboxProofStackConfig = (identity: SandboxProofIdentity) =>
  decodeWorkspaceStackConfig(sandboxProofStackConfigInput(identity)).pipe(
    Effect.map(serializeWorkspaceStackConfig)
  );

const required = (name: string) => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
};

/**
 * The collector digest to declare. A schema without the field refuses a
 * live run; a dry run omits it so the sequence still prints.
 */
const collectorImage = (digest: string, dryRun: boolean) => {
  if (digest === "") {
    return undefined;
  }
  if (stackConfigDeclaresTelemetryCollector) {
    return digest;
  }
  if (dryRun) {
    console.error(
      "dry run: the stack config schema has no telemetryCollectorImage; omitted"
    );
    return undefined;
  }
  throw new Error(
    "The stack config schema has no telemetryCollectorImage field; the collector sidecar cannot be declared"
  );
};

if (import.meta.main) {
  const identity: SandboxProofIdentity = {
    projectId: required("SANDBOX_PROJECT_ID"),
    projectNumber: required("SANDBOX_PROJECT_NUMBER"),
    region: required("SANDBOX_REGION"),
    stateBucket: required("SANDBOX_STATE_BUCKET"),
    telemetryCollectorImage: collectorImage(
      process.env.SANDBOX_TELEMETRY_COLLECTOR_DIGEST ?? "",
      process.env.SANDBOX_STACK_CONFIG_DRY_RUN === "true"
    ),
    disposableQueueSuffix: process.env.SANDBOX_QUEUE_SUFFIX || undefined,
  };
  process.stdout.write(
    `${await Effect.runPromise(sandboxProofStackConfig(identity))}\n`
  );
}
