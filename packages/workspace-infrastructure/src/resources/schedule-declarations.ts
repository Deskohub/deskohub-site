import type { JobProps } from "@alchemy.run/gcp/CloudScheduler";
import type { WorkspaceStackConfig } from "../config/stack-config";
import {
  type ScheduleContract,
  workspaceScheduleTimeZone,
} from "../contracts/schedule-contracts";
import { toGcpDuration } from "./queue-declarations";
import { workloadAudience, workloadUrl } from "./workload-names";

/**
 * A Cloud Scheduler job calling the private scheduler worker with an OIDC
 * token for the scheduler invoker. Jobs stay paused unless the stage is
 * authorized to run schedules (#1456).
 */
export const scheduleJobProps = (
  config: WorkspaceStackConfig,
  contract: ScheduleContract
): JobProps => ({
  jobId: contract.jobId,
  location: config.region,
  schedule: contract.schedule,
  timeZone: workspaceScheduleTimeZone,
  attemptDeadline: toGcpDuration(contract.attemptDeadline),
  // The next tick is the retry; a missed tick is caught by the sweep.
  retryConfig: { retryCount: 0 },
  httpTarget: {
    uri: `${workloadUrl(config, "scheduler-worker")}${contract.handlerPath}`,
    httpMethod: "GET",
    oidcToken: {
      serviceAccountEmail: config.serviceAccounts.schedulerInvoker,
      audience: workloadAudience(config, "scheduler-worker"),
    },
  },
  paused: !config.schedulesEnabled,
});
