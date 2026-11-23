import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import type { ChildProcessHandle } from "effect/process/ChildProcessSpawner";
import type * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

/**
 * Every Effect log, Alchemy's included, goes to stderr, so a command's
 * stdout holds only what it prints on purpose, such as a JSON result.
 */
export const withLogsOnStderr = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.provideService(self, Logger.LogToStderr, true);

/**
 * Run a command-line program on Bun with its logs on stderr, the layers
 * it builds included.
 */
export const runCommandLine = <A, E>(
  program: Effect.Effect<A, E, BunServices.BunServices>
) =>
  program.pipe(
    Effect.provide(BunServices.layer),
    withLogsOnStderr,
    BunRuntime.runMain
  );

/**
 * A child's exit code, with everything it writes to a piped stdout
 * forwarded to this process's stderr: a child's progress never mixes into
 * the parent's own stdout result.
 */
export const exitCodeWithOutputOnStderr = (
  handle: ChildProcessHandle,
  stdio: Stdio.Stdio
) =>
  Effect.all([Stream.run(handle.stdout, stdio.stderr()), handle.exitCode], {
    concurrency: 2,
  }).pipe(Effect.map(([, exitCode]) => exitCode));
