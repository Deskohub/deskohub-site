import type { ServiceProps, TrafficTarget } from "@alchemy.run/gcp/Run";
import type * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import type {
  ImageDigest,
  WorkspaceStackConfig,
  WorkspaceWorkload,
} from "../config/stack-config";
import { workspaceQueueContracts } from "../contracts/queue-contracts";
import { workspaceScheduleContracts } from "../contracts/schedule-contracts";
import { routableDeployments } from "../release/release-reconciler";
import type { ReleaseRecord } from "../release/release-record";
import { toGcpDuration } from "./queue-declarations";
import {
  workloadAudience,
  workloadRuntimeServiceAccount,
  workloadServiceIds,
  workspaceImageReference,
  workspaceLabels,
} from "./workload-names";

/** Secret Manager references for one workload, pinned to their versions. */
const secretEnvironment = (
  config: WorkspaceStackConfig,
  workload: WorkspaceWorkload
) =>
  config.secrets
    .filter((secret) => secret.consumers.includes(workload))
    .map((secret) => ({
      name: secret.environmentVariable,
      valueSource: {
        secretKeyRef: { secret: secret.secretId, version: secret.version },
      },
    }));

/** A worker's request timeout covers the longest handler budget it serves. */
const workerTimeout = (workload: "tasks-worker" | "scheduler-worker") =>
  toGcpDuration(
    Duration.seconds(
      Math.max(
        ...(workload === "tasks-worker"
          ? workspaceQueueContracts.map((contract) => contract.dispatchDeadline)
          : workspaceScheduleContracts.map(
              (contract) => contract.attemptDeadline
            )
        ).map(Duration.toSeconds)
      )
    )
  );

const container = (
  config: WorkspaceStackConfig,
  workload: WorkspaceWorkload,
  imageDigest: ImageDigest
) => ({
  image: workspaceImageReference(config, imageDigest),
  ports: [{ containerPort: 8080 }],
  env: [
    { name: "WORKSPACE_RUNTIME_ROLE", value: workload },
    ...secretEnvironment(config, workload),
  ],
});

/**
 * Untagged traffic goes to the release being applied, else the active one;
 * every other routable release keeps a zero-percent tag so pages it served
 * can reach it for the compatible window.
 */
export const webTraffic = (
  record: ReleaseRecord,
  now: DateTime.Utc
): ReadonlyArray<TrafficTarget> => {
  const [serving, ...compatible] = routableDeployments(record, now);
  if (serving === undefined) {
    return [];
  }
  return [
    {
      type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION",
      revision: serving.revision,
      percent: 100,
      tag: `release-${serving.releaseId}`,
    },
    ...compatible.map((deployment) => ({
      type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION",
      revision: deployment.revision,
      percent: 0,
      tag: `release-${deployment.releaseId}`,
    })),
  ];
};

/**
 * The public web service. Only the external load balancer reaches it
 * (`infra/workspace-edge`), and its default URL is off so traffic cannot
 * bypass Cloud Armor.
 */
export const webServiceProps = (
  config: WorkspaceStackConfig,
  record: ReleaseRecord,
  now: DateTime.Utc
): ServiceProps | undefined => {
  const target = record.pendingApply?.target ?? record.active;
  if (target === null) {
    return undefined;
  }
  return {
    serviceId: workloadServiceIds.web,
    location: config.region,
    labels: workspaceLabels(config),
    ingress: "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
    invokerIamDisabled: true,
    defaultUriDisabled: true,
    template: {
      revision: target.revision,
      serviceAccount: config.serviceAccounts.webRuntime,
      timeout: "300s",
      scaling: {
        minInstanceCount: 0,
        maxInstanceCount: config.capacity.webMaxInstances,
      },
      containers: [container(config, "web", target.imageDigest)],
    },
    traffic: [...webTraffic(record, now)],
  };
};

/**
 * A private worker: internal ingress, IAM invoker required, and a custom
 * audience distinct from every other worker.
 */
export const workerServiceProps = (
  config: WorkspaceStackConfig,
  workload: "tasks-worker" | "scheduler-worker",
  imageDigest: ImageDigest
): ServiceProps => ({
  serviceId: workloadServiceIds[workload],
  location: config.region,
  labels: workspaceLabels(config),
  ingress: "INGRESS_TRAFFIC_INTERNAL_ONLY",
  invokerIamDisabled: false,
  customAudiences: [workloadAudience(config, workload)],
  template: {
    serviceAccount: workloadRuntimeServiceAccount(config, workload),
    timeout: workerTimeout(workload),
    scaling: {
      minInstanceCount: 0,
      maxInstanceCount: config.capacity.workerMaxInstances,
    },
    containers: [container(config, workload, imageDigest)],
  },
});
