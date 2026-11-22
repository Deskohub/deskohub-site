import type {
  ImageDigest,
  WorkspaceStackConfig,
  WorkspaceWorkload,
} from "../config/stack-config";

export const workspaceWebServiceId = "workspace-web";
export const workspaceArtifactRepositoryId = "workspace";
export const workspaceImageName = "workspace";

export const workloadServiceIds: Record<WorkspaceWorkload, string> = {
  web: workspaceWebServiceId,
  "tasks-worker": "workspace-tasks-worker",
  "scheduler-worker": "workspace-scheduler-worker",
};

/**
 * The deterministic run.app URL of a service. Declarations use it so
 * queue and schedule targets need no apply-time output; readback checks
 * that the live service reports the same URL.
 */
export const workloadHost = (
  config: WorkspaceStackConfig,
  workload: WorkspaceWorkload
) =>
  `${workloadServiceIds[workload]}-${config.projectNumber}.${config.region}.run.app`;

export const workloadUrl = (
  config: WorkspaceStackConfig,
  workload: WorkspaceWorkload
) => `https://${workloadHost(config, workload)}`;

/** The runtime identity a workload's revisions run as. */
export const workloadRuntimeServiceAccount = (
  config: WorkspaceStackConfig,
  workload: WorkspaceWorkload
) => {
  switch (workload) {
    case "web":
      return config.serviceAccounts.webRuntime;
    case "tasks-worker":
      return config.serviceAccounts.tasksWorkerRuntime;
    case "scheduler-worker":
      return config.serviceAccounts.schedulerWorkerRuntime;
  }
};

/** A distinct OIDC audience per private worker and project (#1456). */
export const workloadAudience = (
  config: WorkspaceStackConfig,
  workload: WorkspaceWorkload
) => `workspace:${config.projectId}:${workloadServiceIds[workload]}`;

/** The image reference, pinned by digest; Cloud Run never resolves a tag. */
export const workspaceImageReference = (
  config: WorkspaceStackConfig,
  imageDigest: ImageDigest
) =>
  `${config.region}-docker.pkg.dev/${config.projectId}/${workspaceArtifactRepositoryId}/${workspaceImageName}@${imageDigest}`;

export const workspaceLabels = (config: WorkspaceStackConfig) => ({
  "deskohub-app": "workspace",
  "deskohub-stage": config.stage,
});
