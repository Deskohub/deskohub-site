import * as ArtifactRegistry from "@alchemy.run/gcp/ArtifactRegistry";
import * as CloudScheduler from "@alchemy.run/gcp/CloudScheduler";
import * as CloudTasks from "@alchemy.run/gcp/CloudTasks";
import * as IAM from "@alchemy.run/gcp/IAM";
import * as Monitoring from "@alchemy.run/gcp/Monitoring";
import type { ServiceProps } from "@alchemy.run/gcp/Run";
import * as Run from "@alchemy.run/gcp/Run";
import * as Storage from "@alchemy.run/gcp/Storage";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type {
  WorkspaceStackConfig,
  WorkspaceWorkload,
} from "./config/stack-config";
import { workspaceQueueContracts } from "./contracts/queue-contracts";
import { workspaceScheduleContracts } from "./contracts/schedule-contracts";
import {
  readFencedReleaseRecord,
  requireRecordCoversLiveService,
} from "./release/release-delivery";
import { ReleaseApplyPending } from "./release/release-reconciler";
import type { ReleaseRecord } from "./release/release-record";
import { ReleaseRecordStore } from "./release/release-record-store";
import {
  alertPolicyDeclarations,
  artifactRepositoryProps,
  mobileUpdatesBucketProps,
  mobileUpdatesPublisherGrant,
  secretAccessorGrants,
  workerInvokerGrants,
} from "./resources/platform-declarations";
import { queueProps } from "./resources/queue-declarations";
import { scheduleJobProps } from "./resources/schedule-declarations";
import {
  webServiceProps,
  workerServiceProps,
} from "./resources/service-declarations";

/**
 * Preview services stay undeclared until IAP and per-SHA worker isolation
 * exist (#1455); a preview must never get an unprotected public service.
 */
export class PreviewServicesUnprotected extends Data.TaggedError(
  "PreviewServicesUnprotected"
) {}

const pascal = (id: string) =>
  id
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

/**
 * Resources that hold no release state: images, mobile assets, queues,
 * alerts and, only where the stage authorizes them, schedules. An
 * unauthorized stage declares no Scheduler job at all, so no interrupted
 * create can leave one running.
 */
export const declareWorkspaceFoundation = (config: WorkspaceStackConfig) =>
  Effect.gen(function* () {
    const repository = yield* ArtifactRegistry.Repository(
      "WorkspaceImages",
      artifactRepositoryProps(config)
    );
    const mobileUpdates = yield* Storage.Bucket(
      "MobileUpdates",
      mobileUpdatesBucketProps(config)
    );
    const publisher = mobileUpdatesPublisherGrant(config);
    yield* IAM.Member(publisher.id, {
      ...publisher.props,
      name: mobileUpdates.bucketName,
    });
    const queues = yield* Effect.forEach(workspaceQueueContracts, (contract) =>
      CloudTasks.Queue(
        `Queue${pascal(contract.queueId)}`,
        queueProps(config, contract)
      )
    );
    const jobs = config.schedulesEnabled
      ? yield* Effect.forEach(workspaceScheduleContracts, (contract) =>
          CloudScheduler.Job(
            `Schedule${pascal(contract.jobId)}`,
            scheduleJobProps(config, contract)
          )
        )
      : [];
    yield* Effect.forEach(alertPolicyDeclarations(config), ({ id, props }) =>
      Monitoring.AlertPolicy(id, props)
    );
    return {
      repository: repository.name,
      mobileUpdatesBucket: mobileUpdates.bucketName,
      queues: queues.map((queue) => queue.name),
      jobs: jobs.map((job) => job.name),
    };
  });

/**
 * Point each secret reference of a service at its accessor grant's output,
 * so Alchemy applies the grant before the revision that reads the secret.
 */
const withSecretGrants = (
  props: ServiceProps,
  workload: WorkspaceWorkload,
  grants: ReadonlyMap<string, IAM.Member>
) => ({
  ...props,
  template: {
    ...props.template,
    containers: (props.template?.containers ?? []).map((container) => ({
      ...container,
      env: ("env" in container ? (container.env ?? []) : []).map((env) => {
        const secret = env.valueSource?.secretKeyRef?.secret;
        const grant =
          secret === undefined
            ? undefined
            : grants.get(`${secret}|${workload}`);
        return grant === undefined ||
          env.valueSource?.secretKeyRef === undefined
          ? env
          : {
              ...env,
              valueSource: {
                secretKeyRef: {
                  ...env.valueSource.secretKeyRef,
                  secret: grant.name,
                },
              },
            };
      }),
    })),
  },
});

/**
 * The release-owned services. They derive from the authoritative release
 * record, so only a caller holding that record under its generation fence
 * may declare them; nothing is declared before a release serves. The web
 * service carries the record's traffic generation for drift readback.
 */
export const declareWorkspaceServices = (
  config: WorkspaceStackConfig,
  record: ReleaseRecord,
  now: DateTime.Utc
) =>
  Effect.gen(function* () {
    if (config.stage === "preview") {
      return yield* new PreviewServicesUnprotected();
    }
    const web = webServiceProps(config, record, now);
    const serving = record.pendingApply?.target ?? record.active;
    if (web === undefined || serving === null) {
      return undefined;
    }
    const grantDeclarations = secretAccessorGrants(config);
    const grants = new Map<string, IAM.Member>();
    for (const grant of grantDeclarations) {
      const member = yield* IAM.Member(grant.id, grant.props);
      grants.set(`${grant.props.name}|${grant.workload}`, member);
    }

    const webService = yield* Run.Service(
      "WorkspaceWeb",
      withSecretGrants(web, "web", grants)
    );
    const tasksWorker = yield* Run.Service(
      "WorkspaceTasksWorker",
      withSecretGrants(
        workerServiceProps(config, "tasks-worker", serving.imageDigest),
        "tasks-worker",
        grants
      )
    );
    const schedulerWorker = yield* Run.Service(
      "WorkspaceSchedulerWorker",
      withSecretGrants(
        workerServiceProps(config, "scheduler-worker", serving.imageDigest),
        "scheduler-worker",
        grants
      )
    );

    // Invoker grants name the declared services, so they follow them.
    const [tasksInvoker, schedulerInvoker] = workerInvokerGrants(config);
    for (const [grant, service] of [
      [tasksInvoker, tasksWorker],
      [schedulerInvoker, schedulerWorker],
    ] as const) {
      if (grant !== undefined) {
        yield* IAM.Member(grant.id, { ...grant.props, name: service.name });
      }
    }

    return {
      webService: webService.name,
      webLatestReadyRevision: webService.latestReadyRevision,
      tasksWorkerUri: tasksWorker.uri,
      schedulerWorkerUri: schedulerWorker.uri,
    };
  });

/**
 * The record a plain deploy re-declares. A pending traffic change belongs
 * to the release run that persisted it; only its fenced apply or `recover`
 * may declare it, so a plain deploy refuses while one is pending. A staged
 * candidate alone is fine: re-declaring it is what the candidate apply did.
 */
const readUnfencedReleaseRecord = Effect.gen(function* () {
  const { record } = yield* (yield* ReleaseRecordStore).read;
  if (record.pendingApply !== null) {
    return yield* new ReleaseApplyPending({
      releaseId: record.pendingApply.target.releaseId,
    });
  }
  return record;
});

/**
 * The release-owned services as the authoritative release record declares
 * them now. Every deploy of a stage that serves a release must declare them,
 * or Alchemy would delete them; a fenced apply passes the generation it
 * persisted and refuses a record any other run has since moved on, and a
 * record without a serving release is refused while the web service is
 * live (`ReleaseRecordLost`). Preview
 * declares none until #1455.
 */
export const declareRecordedWorkspaceServices = (
  config: WorkspaceStackConfig,
  expectedGeneration: number | undefined
) =>
  Effect.gen(function* () {
    if (config.stage === "preview") {
      return expectedGeneration === undefined
        ? undefined
        : yield* new PreviewServicesUnprotected();
    }
    const record =
      expectedGeneration === undefined
        ? yield* readUnfencedReleaseRecord
        : yield* readFencedReleaseRecord(expectedGeneration);
    // Declaring nothing from a lost record would delete the live services.
    yield* requireRecordCoversLiveService(record);
    return yield* declareWorkspaceServices(config, record, yield* DateTime.now);
  });
