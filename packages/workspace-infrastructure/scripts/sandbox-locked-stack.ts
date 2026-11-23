import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import type * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import type { WorkspaceStackConfig } from "../src/config/stack-config";
import {
  releaseApplyGenerationVariable,
  releaseWriterVariable,
} from "../src/release/alchemy-service-apply";
import {
  liveReleaseRuntime,
  ReleaseStack,
} from "../src/release/release-command";
import {
  HeldReleaseWriter,
  withReleaseWriter,
} from "../src/release/release-writer";

/**
 * Alchemy commands the sandbox proof needs that the release command has no
 * verb for. Each runs under the stage's writer lock, like `release deploy`,
 * so the proof never becomes a second stack writer.
 */
export const lockedStackActions = {
  /** Detect drift: exit 2 when found, 0 when clean. Changes nothing. */
  drift: {
    operation: "plan",
    mutates: false,
    acceptedExitCodes: [0, 2],
    args: (stage: string) => ["drift", "alchemy.run.ts", "--stage", stage],
  },
  /** Repair detected drift back to the declarations. */
  repair: {
    operation: "deploy",
    mutates: true,
    acceptedExitCodes: [0],
    args: (stage: string) => [
      "drift",
      "alchemy.run.ts",
      "--stage",
      stage,
      "--repair",
      "--yes",
    ],
  },
  /** Destroy exactly this stage's stack. */
  destroy: {
    operation: "deploy",
    mutates: true,
    acceptedExitCodes: [0],
    args: (stage: string) => [
      "destroy",
      "alchemy.run.ts",
      "--stage",
      stage,
      "--yes",
    ],
  },
} as const;

export type LockedStackAction = keyof typeof lockedStackActions;

export const isLockedStackAction = (
  value: string | undefined
): value is LockedStackAction =>
  value !== undefined && Object.hasOwn(lockedStackActions, value);

/** The Alchemy arguments of one locked action. */
export const lockedStackArgs = (action: LockedStackAction, stage: string) => [
  ...lockedStackActions[action].args(stage),
  "--no-input",
];

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const alchemyCli = join(packageRoot, "node_modules", ".bin", "alchemy");

const lockedStackCommand = (
  config: WorkspaceStackConfig,
  action: LockedStackAction,
  writer: Redacted.Redacted<string>
) =>
  ChildProcess.make(alchemyCli, lockedStackArgs(action, config.stage), {
    cwd: packageRoot,
    env: {
      [releaseWriterVariable]: writer,
      [releaseApplyGenerationVariable]: undefined,
    },
    extendEnv: true,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });

/**
 * Run one action as the lock holder. A mutating run whose exit is not an
 * accepted one leaves the lock in doubt, as an unknown apply outcome does.
 */
const runLocked = (action: LockedStackAction) =>
  Effect.gen(function* () {
    const config = yield* ReleaseStack;
    const spec = lockedStackActions[action];
    return yield* withReleaseWriter(
      config,
      spec.operation
    )(
      Effect.gen(function* () {
        const { writer, applyInFlight } = yield* HeldReleaseWriter;
        const spawner = yield* ChildProcessSpawner;
        yield* Ref.set(applyInFlight, spec.mutates);
        const exitCode = yield* spawner
          .spawn(lockedStackCommand(config, action, writer.token))
          .pipe(
            Effect.flatMap((handle) => handle.exitCode),
            Effect.scoped
          );
        if (
          (spec.acceptedExitCodes as ReadonlyArray<number>).includes(exitCode)
        ) {
          yield* Ref.set(applyInFlight, false);
        }
        return exitCode;
      })
    );
  });

if (import.meta.main) {
  const action = process.argv[2];
  if (!isLockedStackAction(action)) {
    console.error(
      `usage: sandbox-locked-stack.ts <${Object.keys(lockedStackActions).join("|")}>`
    );
    process.exit(64);
  }
  runLocked(action).pipe(
    Effect.tap((exitCode) =>
      Effect.sync(() => {
        process.exitCode = exitCode;
      })
    ),
    Effect.provide(
      liveReleaseRuntime.pipe(Layer.provideMerge(BunServices.layer))
    ),
    BunRuntime.runMain
  );
}
