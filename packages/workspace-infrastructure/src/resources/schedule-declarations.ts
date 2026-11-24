import type { JobProps } from "@alchemy.run/gcp/CloudScheduler";
import * as Duration from "effect/Duration";
import type { WorkspaceStackConfig } from "../config/stack-config";
import {
  type ScheduleContract,
  workspaceScheduleTimeZone,
} from "../contracts/schedule-contracts";
import { toGcpDuration } from "./queue-declarations";
import { workloadAudience, workloadUrl } from "./workload-names";

/**
 * A Cloud Scheduler job calling the private scheduler worker with an OIDC
 * token for the scheduler invoker. Only stages authorized to run schedules
 * declare jobs at all (#1456, `declareWorkspaceFoundation`).
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
  paused: false,
});

/**
 * The hosted proof's own scheduler jobs (sandbox only, once the run has a
 * disposable suffix). They stay paused, so they fire only when the proof
 * runs them by hand, and they call proof-only paths no Workspace schedule
 * serves.
 *
 * `proof-tick` signs as the scheduler invoker and must reach the scheduler
 * worker. The `proof-deny-*` jobs come from the same source the workers'
 * internal ingress admits, so their runs show IAM itself refusing: an
 * unsigned call to each worker, and the scheduler invoker calling the tasks
 * worker it may not invoke. The proof requires each to end in
 * PERMISSION_DENIED.
 */
export const sandboxProofScheduleJobs = (
  config: WorkspaceStackConfig
): ReadonlyArray<{ readonly id: string; readonly props: JobProps }> => {
  if (
    config.stage !== "sandbox" ||
    config.disposableQueueSuffix === undefined
  ) {
    return [];
  }
  const suffix = config.disposableQueueSuffix;
  const job = (
    id: string,
    name: string,
    workload: "tasks-worker" | "scheduler-worker",
    path: string,
    signed: boolean
  ) => {
    const unsigned = {
      uri: `${workloadUrl(config, workload)}${path}`,
      httpMethod: "GET",
    } satisfies JobProps["httpTarget"];
    const httpTarget: JobProps["httpTarget"] = signed
      ? {
          ...unsigned,
          oidcToken: {
            serviceAccountEmail: config.serviceAccounts.schedulerInvoker,
            audience: workloadAudience(config, workload),
          },
        }
      : unsigned;
    return {
      id,
      props: {
        jobId: `workspace-proof-${name}-${suffix}`,
        location: config.region,
        schedule: "0 0 1 1 *",
        timeZone: workspaceScheduleTimeZone,
        attemptDeadline: toGcpDuration(Duration.seconds(60)),
        retryConfig: { retryCount: 0 },
        httpTarget,
        paused: true,
      } satisfies JobProps,
    };
  };
  const tick = "/api/cron/workspace/proof-tick";
  const task = "/api/queues/workspace/proof-deny";
  return [
    job("ScheduleWorkspaceProofTick", "tick", "scheduler-worker", tick, true),
    job(
      "ScheduleWorkspaceProofDenySchedulerAnonymous",
      "deny-scheduler-anonymous",
      "scheduler-worker",
      tick,
      false
    ),
    job(
      "ScheduleWorkspaceProofDenyTasksAnonymous",
      "deny-tasks-anonymous",
      "tasks-worker",
      task,
      false
    ),
    job(
      "ScheduleWorkspaceProofDenyTasksWrongInvoker",
      "deny-tasks-wrong-invoker",
      "tasks-worker",
      task,
      true
    ),
  ];
};
