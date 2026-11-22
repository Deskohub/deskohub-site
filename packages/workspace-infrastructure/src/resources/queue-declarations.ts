import type { QueueProps } from "@alchemy.run/gcp/CloudTasks";
import * as Duration from "effect/Duration";
import type { WorkspaceStackConfig } from "../config/stack-config";
import {
  type QueueContract,
  workspaceQueueRetry,
} from "../contracts/queue-contracts";
import { workloadAudience, workloadHost } from "./workload-names";

/** Cloud Tasks and Cloud Scheduler take durations as `<seconds>s`. */
export const toGcpDuration = (duration: Duration.Duration) =>
  `${Math.round(Duration.toSeconds(duration))}s`;

/**
 * Queue properties for one contract. `maxAttempts: -1` leaves the attempt
 * count unbounded so the contract's lifetime alone ends retries; the
 * provider-default lifetime omits `maxRetryDuration` entirely.
 *
 * The queue-level target always overrides each task's URL and OIDC
 * identity, so a publisher cannot send a task to another handler or
 * present another invoker.
 */
export const queueProps = (
  config: WorkspaceStackConfig,
  contract: QueueContract
): QueueProps => ({
  queueId: contract.queueId,
  location: config.region,
  retryConfig: {
    maxAttempts: -1,
    ...(contract.transportLifetime.kind === "bounded"
      ? {
          maxRetryDuration: toGcpDuration(
            contract.transportLifetime.maxRetryDuration
          ),
        }
      : {}),
    minBackoff: toGcpDuration(workspaceQueueRetry.minBackoff),
    maxBackoff: toGcpDuration(workspaceQueueRetry.maxBackoff),
    maxDoublings: workspaceQueueRetry.maxDoublings,
  },
  rateLimits: {
    maxConcurrentDispatches: config.capacity.queueMaxConcurrentDispatches,
    maxDispatchesPerSecond: config.capacity.queueMaxDispatchesPerSecond,
  },
  // Log attempts without payloads: task bodies hold customer identifiers.
  stackdriverLoggingConfig: { samplingRatio: 1 },
  httpTarget: {
    httpMethod: "POST",
    uriOverride: {
      scheme: "HTTPS",
      host: workloadHost(config, "tasks-worker"),
      pathOverride: { path: contract.handlerPath },
      uriOverrideEnforceMode: "ALWAYS",
    },
    oidcToken: {
      serviceAccountEmail: config.serviceAccounts.tasksInvoker,
      audience: workloadAudience(config, "tasks-worker"),
    },
  },
  state: "RUNNING",
});
