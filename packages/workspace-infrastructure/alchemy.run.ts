import * as GCP from "@alchemy.run/gcp";
import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { configuredWorkspaceStack } from "./src/config/stack-config";
import { workspaceGcpAccess, workspaceGoogleApiAccess } from "./src/gcp-access";
import { releaseApplyGenerationVariable } from "./src/release/alchemy-service-apply";
import { cloudRunServiceReadbackLayer } from "./src/release/cloud-run-readback";
import {
  gcsReleaseRecordStoreLayer,
  releaseRecordLocation,
} from "./src/release/gcs-release-store";
import { verifyStackTarget } from "./src/stack-target";
import {
  declareRecordedWorkspaceServices,
  declareWorkspaceFoundation,
} from "./src/workspace-stack";

const stackConfig = configuredWorkspaceStack.pipe(Effect.orDie);

/** Set only by the fenced release apply (`alchemyServiceApply`). */
const releaseGeneration = Config.option(
  Config.Int(releaseApplyGenerationVariable)
).pipe(Effect.map(Option.getOrUndefined), Effect.orDie);

/**
 * The Workspace stack. State lives in the config's own state bucket,
 * reached only after `verifyStackTarget`, so credentials or state of one
 * stage never apply another.
 *
 * The release-owned Cloud Run services come from the authoritative release
 * record in that bucket, never from a CI snapshot. A fenced release apply
 * sets `WORKSPACE_RELEASE_GENERATION` and the deploy refuses a record at any
 * other generation; a plain deploy re-declares the current record so the
 * services are kept.
 */
export default Alchemy.Stack(
  "DeskohubWorkspace",
  {
    providers: GCP.providers(),
    state: Layer.unwrap(
      stackConfig.pipe(
        Effect.map((config) =>
          Layer.mergeAll(
            GCP.state({ bucketName: config.stateBucket }),
            Layer.effectDiscard(verifyStackTarget(config)).pipe(
              // The same resolution the GCS state store uses.
              Layer.provide(workspaceGcpAccess),
              Layer.orDie
            )
          )
        )
      )
    ),
  },
  Effect.gen(function* () {
    const config = yield* stackConfig;
    const foundation = yield* declareWorkspaceFoundation(config);
    const services = yield* declareRecordedWorkspaceServices(
      config,
      yield* releaseGeneration
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          gcsReleaseRecordStoreLayer(releaseRecordLocation(config)),
          cloudRunServiceReadbackLayer(config)
        ).pipe(Layer.provide(workspaceGoogleApiAccess))
      ),
      // A stale fence, lost or unreadable record or unprotected preview stops the
      // deploy before any service is planned.
      Effect.orDie
    );
    return { ...foundation, services };
  })
);
