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
import {
  type ReleaseId,
  type ReleaseRecord,
  templateRevisionOf,
} from "../release/release-record";
import { sha256Hex } from "../sha256";
import { toGcpDuration } from "./queue-declarations";
import {
  secretResourceName,
  workloadAudience,
  workloadRuntimeServiceAccount,
  workloadServiceIds,
  workspaceArtifactRepositoryId,
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

/**
 * The OIDC identity and audience a private worker accepts, the ones its
 * queue or schedule signs tokens with; the web service accepts none.
 */
const invokerEnvironment = (
  config: WorkspaceStackConfig,
  workload: WorkspaceWorkload
) => {
  switch (workload) {
    case "web":
      return [];
    case "tasks-worker":
      return [
        {
          name: "WORKSPACE_TASKS_AUDIENCE",
          value: workloadAudience(config, workload),
        },
        {
          name: "WORKSPACE_TASKS_INVOKER_EMAIL",
          value: config.serviceAccounts.tasksInvoker,
        },
      ];
    case "scheduler-worker":
      return [
        {
          name: "WORKSPACE_SCHEDULER_AUDIENCE",
          value: workloadAudience(config, workload),
        },
        {
          name: "WORKSPACE_SCHEDULER_INVOKER_EMAIL",
          value: config.serviceAccounts.schedulerInvoker,
        },
      ];
  }
};

/** The collector sidecar image in the stage's Workspace repository. */
export const workspaceTelemetryCollectorImageName = "workspace-otel-collector";

/** The name of the app container once the revision has a sidecar. */
export const workspaceAppContainerName = "workspace";

/** The name of the OpenTelemetry collector sidecar container. */
export const telemetryCollectorContainerName = "otel-collector";

/**
 * The collector's loopback OTLP/HTTP receiver, as
 * `apps/deskohub-workspace/otel-collector.cloudrun.yaml` binds it.
 */
export const telemetryCollectorOtlpEndpoint = "http://127.0.0.1:4318";

/** The collector's `health_check` extension port, from the same config. */
const telemetryCollectorHealthPort = 13133;

const telemetryCollectorContainer = (
  config: WorkspaceStackConfig,
  imageDigest: ImageDigest
) => ({
  name: telemetryCollectorContainerName,
  image: `${config.region}-docker.pkg.dev/${config.projectId}/${workspaceArtifactRepositoryId}/${workspaceTelemetryCollectorImageName}@${imageDigest}`,
  // The app starts only once the collector reports healthy.
  startupProbe: {
    httpGet: { path: "/", port: telemetryCollectorHealthPort },
    periodSeconds: 2,
    timeoutSeconds: 1,
    failureThreshold: 30,
  },
  livenessProbe: {
    httpGet: { path: "/", port: telemetryCollectorHealthPort },
    periodSeconds: 30,
    timeoutSeconds: 5,
    failureThreshold: 3,
  },
});

/**
 * The containers of a revision: the app alone, or, when the stage names a
 * collector image, the named app container that alone takes ingress and
 * starts after the collector sidecar it exports spans to.
 */
const containers = (
  config: WorkspaceStackConfig,
  workload: WorkspaceWorkload,
  imageDigest: ImageDigest
) => {
  const app = {
    image: workspaceImageReference(config, imageDigest),
    ports: [{ containerPort: 8080 }],
    env: [
      { name: "WORKSPACE_RUNTIME_ROLE", value: workload },
      ...invokerEnvironment(config, workload),
      ...secretEnvironment(config, workload),
    ],
  };
  const collectorImage = config.telemetryCollectorImage;
  if (collectorImage === undefined) {
    return [app];
  }
  return [
    {
      name: workspaceAppContainerName,
      ...app,
      env: [
        ...app.env,
        {
          name: "WORKSPACE_OTLP_ENDPOINT",
          value: telemetryCollectorOtlpEndpoint,
        },
      ],
      dependsOn: [telemetryCollectorContainerName],
    },
    telemetryCollectorContainer(config, collectorImage),
  ];
};

/**
 * The template annotation carrying the fingerprint of the template spec,
 * so readback can tell a template declared from an older config apart.
 */
export const templateSpecAnnotation = "deskohub.workspace/template-spec";

/** The web revision template for one image, without its revision name. */
const webTemplateSpec = (
  config: WorkspaceStackConfig,
  imageDigest: ImageDigest
) => ({
  serviceAccount: config.serviceAccounts.webRuntime,
  timeout: "300s",
  scaling: {
    minInstanceCount: 0,
    maxInstanceCount: config.capacity.webMaxInstances,
  },
  containers: containers(config, "web", imageDigest),
});

/**
 * A short sha256 fingerprint of the web template spec for one image. Two
 * templates with the same fingerprint may share a revision name.
 */
export const webTemplateSpecFingerprint = (
  config: WorkspaceStackConfig,
  imageDigest: ImageDigest
) =>
  sha256Hex(JSON.stringify(webTemplateSpec(config, imageDigest))).slice(0, 16);

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
 * (`declareWorkspaceEdge`), and its default URL is off so traffic cannot
 * bypass Cloud Armor.
 *
 * The template is the candidate, else the revision last materialized; only
 * the very first release takes its template from the pending promotion. A
 * candidate therefore becomes a real zero-traffic revision while the active
 * one keeps serving, and promote and restore change traffic only. Nothing
 * is declared before a release serves.
 */
/**
 * The revision name and image the web template is declared with: the
 * candidate, else the materialized template under the name the record
 * declared it, else the serving release. `specFingerprint` is the spec a
 * minted name was decided for, or null for a release's own name. Null
 * before a release serves.
 */
export const declaredWebTemplate = (record: ReleaseRecord) => {
  const serving = servingDeployment(record);
  if (serving === null) {
    return null;
  }
  const template = record.candidate ?? record.materialized ?? serving;
  return {
    revision:
      template === record.materialized
        ? templateRevisionOf(record.materialized)
        : template.revision,
    imageDigest: template.imageDigest,
    specFingerprint:
      template === record.materialized
        ? (record.materialized.template?.specFingerprint ?? null)
        : null,
  };
};

export const webServiceProps = (
  config: WorkspaceStackConfig,
  record: ReleaseRecord,
  now: DateTime.Utc
): ServiceProps | undefined => {
  const template = declaredWebTemplate(record);
  if (template === null) {
    return undefined;
  }
  const { revision } = template;
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
      revision,
      annotations: {
        [templateSpecAnnotation]: webTemplateSpecFingerprint(
          config,
          template.imageDigest
        ),
      },
      ...webTemplateSpec(config, template.imageDigest),
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
    containers: containers(config, workload, imageDigest),
  },
});
