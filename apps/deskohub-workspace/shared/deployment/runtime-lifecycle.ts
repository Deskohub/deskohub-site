import { waitUntil } from "@vercel/functions";
import { Data, type Duration, Effect } from "effect";

/**
 * How the host runs and stops Workspace processes. On Vercel a function
 * instance lives per invocation and Vercel's `waitUntil` keeps it running
 * for work that outlives the response. A container host, such as Cloud Run,
 * keeps one process serving until it sends SIGTERM and then kills it after
 * a grace period, so the process drains that work and flushes telemetry
 * itself before it exits.
 *
 * The state lives on `globalThis`: Next.js evaluates modules once for
 * `instrumentation.ts` and again for the app bundles, and both must see the
 * same pending work and shutdown hooks. Hooks are plain promise thunks so
 * they cross those module instances.
 */
const runtimeLifecycleKey = Symbol.for("@deskohub-workspace/runtime-lifecycle");

/**
 * When a shutdown hook runs: after in-flight work drains, `flush` hooks
 * export telemetry, and `close` hooks release connections last.
 */
export type RuntimeShutdownStage = "flush" | "close";

export interface RuntimeShutdownHook {
  /** A stable name; registering it again replaces the earlier hook. */
  readonly name: string;
  readonly stage: RuntimeShutdownStage;
  readonly run: () => Promise<unknown>;
}

interface RuntimeLifecycle {
  /** Work the process must finish before it exits, once it tracks any. */
  readonly pending: Set<Promise<void>>;
  readonly hooks: Map<string, RuntimeShutdownHook>;
  tracksPending: boolean;
  shutdown?: Promise<void>;
}

type GlobalWithRuntimeLifecycle = typeof globalThis & {
  [runtimeLifecycleKey]?: RuntimeLifecycle;
};

const runtimeLifecycle = (): RuntimeLifecycle => {
  const holder = globalThis as GlobalWithRuntimeLifecycle;
  holder[runtimeLifecycleKey] ??= {
    pending: new Set(),
    hooks: new Map(),
    tracksPending: false,
  };
  return holder[runtimeLifecycleKey];
};

const ignoreSettlement = () => undefined;

/**
 * Keeps the runtime serving until `work` settles, after the response if
 * need be. On Vercel this is exactly `waitUntil`. A container process that
 * installed its shutdown (`installRuntimeShutdown`) also waits for the work
 * before it exits; elsewhere nothing else happens.
 */
export const keepRuntimeAliveUntil = (work: Promise<unknown>): void => {
  waitUntil(work);
  const lifecycle = runtimeLifecycle();
  if (!lifecycle.tracksPending) return;
  const settled = work.then(ignoreSettlement, ignoreSettlement);
  lifecycle.pending.add(settled);
  void settled.then(() => lifecycle.pending.delete(settled));
};

/** Runs `hook` when the process shuts down; a no-op on Vercel. */
export const onRuntimeShutdown = (hook: RuntimeShutdownHook): void => {
  runtimeLifecycle().hooks.set(hook.name, hook);
};

/**
 * Cloud Run sends SIGKILL 10 seconds after SIGTERM. Draining gets most of
 * that, and the flush and close stages keep their own share, so telemetry
 * of work that never finished still leaves the process.
 */
export interface RuntimeShutdownBudget {
  readonly drain: Duration.Input;
  readonly flush: Duration.Input;
  readonly close: Duration.Input;
}

const containerShutdownBudget: RuntimeShutdownBudget = {
  drain: "5 seconds",
  flush: "2500 millis",
  close: "1500 millis",
};

class RuntimeShutdownHookError extends Data.TaggedError(
  "RuntimeShutdownHookError"
)<{
  readonly hook: string;
  readonly cause: unknown;
}> {}

/** Waits for tracked work, including work started while it waits. */
const drainPending = (lifecycle: RuntimeLifecycle): Effect.Effect<void> =>
  Effect.suspend(() => {
    const pending = [...lifecycle.pending];
    return pending.length === 0
      ? Effect.void
      : Effect.promise(() => Promise.all(pending)).pipe(
          Effect.andThen(drainPending(lifecycle))
        );
  });

const runHook = (hook: RuntimeShutdownHook) =>
  Effect.tryPromise({
    try: hook.run,
    catch: (cause) => new RuntimeShutdownHookError({ hook: hook.name, cause }),
  }).pipe(
    Effect.catchTag("RuntimeShutdownHookError", ({ hook: name }) =>
      Effect.logWarning("Workspace runtime shutdown hook failed.", {
        hook: name,
      })
    )
  );

const runStage = (
  lifecycle: RuntimeLifecycle,
  stage: RuntimeShutdownStage,
  budget: Duration.Input
) =>
  Effect.forEach(
    [...lifecycle.hooks.values()].filter((hook) => hook.stage === stage),
    runHook,
    { concurrency: "unbounded", discard: true }
  ).pipe(
    Effect.timeoutOrElse({
      duration: budget,
      orElse: () =>
        Effect.logWarning("Workspace runtime shutdown stage ran out of time.", {
          stage,
        }),
    })
  );

/**
 * Drains tracked work, then runs the flush hooks and then the close hooks,
 * each within its share of `budget`. Never fails.
 */
export const shutdownRuntime = Effect.fn("runtime.shutdown")(function* (
  budget: RuntimeShutdownBudget = containerShutdownBudget
) {
  const lifecycle = runtimeLifecycle();
  yield* Effect.logInfo("Workspace runtime shutdown started.", {
    pending: lifecycle.pending.size,
  });
  yield* drainPending(lifecycle).pipe(
    Effect.timeoutOrElse({
      duration: budget.drain,
      orElse: () =>
        Effect.logWarning(
          "Workspace runtime shutdown stopped waiting for in-flight work.",
          { pending: lifecycle.pending.size }
        ),
    })
  );
  yield* runStage(lifecycle, "flush", budget.flush);
  yield* runStage(lifecycle, "close", budget.close);
  yield* Effect.logInfo("Workspace runtime shutdown finished.");
});

export interface RuntimeShutdownInstallation {
  /** Runs the shutdown Effect through a Workspace runner. */
  readonly run: (shutdown: Effect.Effect<void>) => Promise<unknown>;
  /** Ends the process once the shutdown settles. */
  readonly exit: (code: number) => void;
  readonly budget?: RuntimeShutdownBudget;
  readonly signals?: readonly NodeJS.Signals[];
}

/**
 * Makes a container process track its pending work and, on the first
 * termination signal, shut down within the budget and exit. Only a container
 * host installs this, and its server must leave the signals to it (Next.js
 * standalone with `NEXT_MANUAL_SIG_HANDLE=true`). Returns the shutdown the
 * signal starts, for tests.
 */
export const installRuntimeShutdown = ({
  run,
  exit,
  budget,
  signals = ["SIGTERM", "SIGINT"],
}: RuntimeShutdownInstallation): (() => Promise<void>) => {
  const lifecycle = runtimeLifecycle();
  lifecycle.tracksPending = true;
  const shutdown = () => {
    lifecycle.shutdown ??= run(shutdownRuntime(budget)).then(
      () => exit(0),
      () => exit(1)
    );
    return lifecycle.shutdown;
  };
  for (const signal of signals) process.once(signal, shutdown);
  return shutdown;
};
