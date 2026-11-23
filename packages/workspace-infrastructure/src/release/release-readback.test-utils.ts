import type { ImageDigest } from "../config/stack-config";
import type { TrafficReadback } from "./release-reconciler";

/** Both workers ready and serving one image, as settlement reads them. */
export const workersServing = (
  imageDigest: ImageDigest | null
): ReadonlyArray<TrafficReadback> =>
  (["workspace-tasks-worker", "workspace-scheduler-worker"] as const).map(
    (service) => ({
      servingRevision: `${service}-00001`,
      servingImageDigest: imageDigest,
      trafficGeneration: null,
    })
  );
