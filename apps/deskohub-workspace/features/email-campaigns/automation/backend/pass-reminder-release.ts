import { Effect, Layer, Option } from "effect";
import { ReleaseGateUnavailableError } from "@/features/feature-flags/backend/release-gate";
import { WorkspaceFeatureFlagService } from "@/features/feature-flags/backend/workspace-feature-flag.service";
import { CoworkPassesReleaseGate } from "@/features/passes/backend/cowork-passes-release-gate";
import { catchRecoverableCause } from "@/shared/backend/workspace-effect";

/**
 * An unattended run has no consented visitor identity. Send a reminder only
 * once the pass itself is available to every holder who receives the link.
 */
export const CoworkPassesReleaseGateForReminders = Layer.unwrap(
  Effect.map(WorkspaceFeatureFlagService, (flags) => {
    const unavailable = () =>
      new ReleaseGateUnavailableError({
        flags: [CoworkPassesReleaseGate.flag],
        message: "Pass reminder release gate unavailable.",
      });
    const decision = flags.constantValue(CoworkPassesReleaseGate.flag).pipe(
      Effect.map(Option.getOrElse(() => false)),
      Effect.mapError(unavailable),
      catchRecoverableCause(() => Effect.fail(unavailable()))
    );
    return CoworkPassesReleaseGate.fromEvaluation(
      decision.pipe(
        Effect.catchTag("ReleaseGateUnavailableError", ({ message }) =>
          Effect.logWarning(message).pipe(Effect.as(false))
        )
      ),
      decision
    );
  })
).pipe(Layer.provide(WorkspaceFeatureFlagService.Default));
