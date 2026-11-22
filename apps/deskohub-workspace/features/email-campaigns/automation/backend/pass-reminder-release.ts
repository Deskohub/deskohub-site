import { Effect, Layer, Option } from "effect";
import { closeUnavailableRelease } from "@/features/feature-flags/backend/release-gate";
import { WorkspaceFeatureFlagService } from "@/features/feature-flags/backend/workspace-feature-flag.service";
import { CoworkPassesReleaseGate } from "@/features/passes/backend/cowork-passes-release-gate";

/**
 * An unattended run has no consented visitor identity. Send a reminder only
 * once the pass itself is available to every holder who receives the link.
 */
export const CoworkPassesReleaseGateForReminders = Layer.unwrap(
  Effect.map(WorkspaceFeatureFlagService, (flags) =>
    CoworkPassesReleaseGate.fromEvaluation(
      flags
        .constantValue(CoworkPassesReleaseGate.flag)
        .pipe(
          Effect.map(Option.getOrElse(() => false)),
          closeUnavailableRelease([CoworkPassesReleaseGate.flag], false)
        )
    )
  )
).pipe(Layer.provide(WorkspaceFeatureFlagService.Default));
