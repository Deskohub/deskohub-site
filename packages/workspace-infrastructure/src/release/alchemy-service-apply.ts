import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import type { WorkspaceStackConfig } from "../config/stack-config";
import {
  ReleaseServiceApply,
  ReleaseServiceApplyFailed,
} from "./release-platform";

/**
 * The variable that switches `alchemy.run.ts` to fenced service apply: the
 * stack declares the release-owned services only from a record at exactly
 * this generation.
 */
export const releaseApplyGenerationVariable = "WORKSPACE_RELEASE_GENERATION";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * `alchemy deploy` of this package's stack for the config's stage, fenced
 * to one release generation. Output streams to the caller's console.
 */
export const alchemyDeployCommand = (
  config: WorkspaceStackConfig,
  generation: number
) =>
  ChildProcess.make(
    "bun",
    [
      "x",
      "alchemy",
      "deploy",
      "alchemy.run.ts",
      "--stage",
      config.stage,
      "--yes",
      "--no-input",
    ],
    {
      cwd: packageRoot,
      env: { [releaseApplyGenerationVariable]: String(generation) },
      extendEnv: true,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    }
  );

/** A service apply that runs one command per generation and checks its exit. */
export const commandServiceApply = (
  command: (generation: number) => ChildProcess.Command
) =>
  Layer.effect(
    ReleaseServiceApply,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner;
      return ReleaseServiceApply.of({
        apply: (generation) =>
          spawner.exitCode(command(generation)).pipe(
            Effect.mapError(
              (error) =>
                new ReleaseServiceApplyFailed({
                  generation,
                  reason: error.message,
                })
            ),
            Effect.flatMap((exitCode) =>
              exitCode === 0
                ? Effect.void
                : Effect.fail(
                    new ReleaseServiceApplyFailed({
                      generation,
                      reason: `The apply exited with code ${exitCode}`,
                    })
                  )
            )
          ),
      });
    })
  );

/** The live apply: a fenced `alchemy deploy` of the config's stage. */
export const alchemyServiceApply = (config: WorkspaceStackConfig) =>
  commandServiceApply((generation) => alchemyDeployCommand(config, generation));
