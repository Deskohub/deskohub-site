import { GcpEnvironment } from "@alchemy.run/gcp";
import { Stage } from "alchemy/Stage";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { WorkspaceStackConfig } from "./config/stack-config";

/** The Alchemy stage or effective project is not the configured one. */
export class StackTargetMismatch extends Data.TaggedError(
  "StackTargetMismatch"
)<{
  readonly configuredStage: string;
  readonly stage: string;
  readonly projectMatches: boolean;
}> {}

/**
 * Refuse to touch state unless the Alchemy stage and the effective GCP
 * project (credentials, profile or environment, as the provider resolves
 * it) both name the config's stage and project. It runs while the state
 * layer builds, so deploy, drift and destroy all pass through it.
 */
export const verifyStackTarget = (config: WorkspaceStackConfig) =>
  Effect.gen(function* () {
    const stage = yield* Stage;
    const { project } = yield* GcpEnvironment.current;
    if (stage !== config.stage || project !== config.projectId) {
      return yield* new StackTargetMismatch({
        configuredStage: config.stage,
        stage,
        projectMatches: project === config.projectId,
      });
    }
  });
