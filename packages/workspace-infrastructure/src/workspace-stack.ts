import * as ArtifactRegistry from "@alchemy.run/gcp/ArtifactRegistry";
import * as CloudScheduler from "@alchemy.run/gcp/CloudScheduler";
import * as CloudTasks from "@alchemy.run/gcp/CloudTasks";
import * as IAM from "@alchemy.run/gcp/IAM";
import * as Monitoring from "@alchemy.run/gcp/Monitoring";
import * as Run from "@alchemy.run/gcp/Run";
import * as Storage from "@alchemy.run/gcp/Storage";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { WorkspaceStackConfig } from "./config/stack-config";
import { workspaceQueueContracts } from "./contracts/queue-contracts";
import { workspaceScheduleContracts } from "./contracts/schedule-contracts";
import type { ReleaseRecord } from "./release/release-record";
import {
  alertPolicyDeclarations,
  artifactRepositoryProps,
  mobileUpdatesBucketProps,
  secretAccessorGrants,
  workerInvokerGrants,
} from "./resources/platform-declarations";
import { queueProps } from "./resources/queue-declarations";
import { scheduleJobProps } from "./resources/schedule-declarations";
import {
  webServiceProps,
  workerServiceProps,
} from "./resources/service-declarations";

const pascal = (id: string) =>
  id
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

/**
 * Declare every Alchemy-owned Workspace resource for one stage. Services
 * deploy only once the release record names a target; until then the
 * stack holds the repository, queues, schedules, bucket and alerts.
 */
export const declareWorkspaceStack = (
  config: WorkspaceStackConfig,
  record: ReleaseRecord,
  now: DateTime.Utc
) =>
  Effect.gen(function* () {
    const repository = yield* ArtifactRegistry.Repository(
      "WorkspaceImages",
      artifactRepositoryProps(config)
    );
    const mobileUpdates = yield* Storage.Bucket(
      "MobileUpdates",
      mobileUpdatesBucketProps(config)
    );

    const target = record.pendingApply?.target ?? record.active;
    const web = webServiceProps(config, record, now);
    const services =
      target === null || web === undefined
        ? undefined
        : {
            web: yield* Run.Service("WorkspaceWeb", web),
            tasksWorker: yield* Run.Service(
              "WorkspaceTasksWorker",
              workerServiceProps(config, "tasks-worker", target.imageDigest)
            ),
            schedulerWorker: yield* Run.Service(
              "WorkspaceSchedulerWorker",
              workerServiceProps(config, "scheduler-worker", target.imageDigest)
            ),
          };

    yield* Effect.forEach(
      [...workerInvokerGrants(config), ...secretAccessorGrants(config)],
      ({ id, props }) => IAM.Member(id, props)
    );
    const queues = yield* Effect.forEach(workspaceQueueContracts, (contract) =>
      CloudTasks.Queue(pascal(contract.queueId), queueProps(config, contract))
    );
    const jobs = yield* Effect.forEach(workspaceScheduleContracts, (contract) =>
      CloudScheduler.Job(
        pascal(contract.jobId),
        scheduleJobProps(config, contract)
      )
    );
    yield* Effect.forEach(alertPolicyDeclarations(config), ({ id, props }) =>
      Monitoring.AlertPolicy(id, props)
    );

    return {
      repository: repository.name,
      mobileUpdatesBucket: mobileUpdates.bucketName,
      webService: services?.web.name,
      webLatestReadyRevision: services?.web.latestReadyRevision,
      tasksWorkerUri: services?.tasksWorker.uri,
      schedulerWorkerUri: services?.schedulerWorker.uri,
      queues: queues.map((queue) => queue.name),
      jobs: jobs.map((job) => job.name),
    };
  });
