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
import type { ReleaseId, ReleaseRecord } from "../release/release-record";
import { toGcpDuration } from "./queue-declarations";
import {
  secretResourceName,
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
        secretKeyRef: {
          secret: secretResourceName(config, secret.secretId),
          version: secret.version,
        },
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

/** The service annotation carrying the record's traffic generation. */
export const trafficGenerationAnnotation =
  "deskohub.workspace/traffic-generation";

/** The traffic tag that keeps a release's revision reachable by URL. */
export const releaseTrafficTag = (releaseId: ReleaseId) =>
  `release-${releaseId}`;

/** The release taking untagged traffic: the one being applied, else active. */
const servingDeployment = (record: ReleaseRecord) =>
  record.pendingApply?.target ?? record.active;

/**
 * Untagged traffic goes to the serving release. The candidate and every
 * release still in its compatible window keep a zero-percent tag, so the
 * candidate can be verified before promotion and pages an older release
 * served can still reach it.
 */
export const webTraffic = (
  record: ReleaseRecord,
  now: DateTime.Utc
): ReadonlyArray<TrafficTarget> => {
  const serving = servingDeployment(record);
  if (serving === null) {
    return [];
  }
  const tagged = [
    ...(record.candidate === null ? [] : [record.candidate]),
    ...routableDeployments(record, now),
  ].filter(
    (deployment, index, all) =>
      deployment.releaseId !== serving.releaseId &&
      all.findIndex((other) => other.releaseId === deployment.releaseId) ===
        index
  );
  return [
    {
      type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION",
      revision: serving.revision,
      percent: 100,
      tag: releaseTrafficTag(serving.releaseId),
    },
    ...tagged.map((deployment) => ({
      type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION",
      revision: deployment.revision,
      percent: 0,
      tag: releaseTrafficTag(deployment.releaseId),
    })),
  ];
};

/**
 * The public web service. Only the external load balancer reaches it
 * (`infra/workspace-edge`), and its default URL is off so traffic cannot
 * bypass Cloud Armor.
 *
 * The template is the candidate, else the revision last materialized; only
 * the very first release takes its template from the pending promotion. A
 * candidate therefore becomes a real zero-traffic revision while the active
 * one keeps serving, and promote and restore change traffic only. Nothing
 * is declared before a release serves.
 */
export const webServiceProps = (
  config: WorkspaceStackConfig,
  record: ReleaseRecord,
  now: DateTime.Utc
): ServiceProps | undefined => {
  const serving = servingDeployment(record);
  if (serving === null) {
    return undefined;
  }
  const template = record.candidate ?? record.materialized ?? serving;
  return {
    serviceId: workloadServiceIds.web,
    location: config.region,
    labels: workspaceLabels(config),
    ingress: "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
    invokerIamDisabled: true,
    defaultUriDisabled: true,
    annotations: {
      [trafficGenerationAnnotation]: String(record.trafficGeneration),
    },
    template: {
      revision: template.revision,
      serviceAccount: config.serviceAccounts.webRuntime,
      timeout: "300s",
      scaling: {
        minInstanceCount: 0,
        maxInstanceCount: config.capacity.webMaxInstances,
      },
      containers: [container(config, "web", template.imageDigest)],
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
