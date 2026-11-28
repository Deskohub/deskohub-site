import { Effect, Result } from "effect";
import type { WorkspaceE2EAccountLaneReconciliation } from "../account/reconcile";
import type { PreparedCheckoutFlowCleanup } from "../cleanup";
import { type WorkspaceE2EError, workspaceE2EError } from "../errors";
import { E2ETelemetryService } from "../services/telemetry";

export type WorkspaceE2ECleanupCandidates = {
  /** The account lane's and every referral-lane case's identity journal. */
  readonly accountJournals: readonly WorkspaceE2EAccountLaneReconciliation[];
  readonly checkoutCleanup: PreparedCheckoutFlowCleanup;
};

export const runWorkspaceE2ECleanupWithPreparedCandidates = async <A>({
  readAccountJournals,
  readCheckoutCleanup,
  reconcile,
}: {
  readonly readAccountJournals: () => Promise<
    readonly WorkspaceE2EAccountLaneReconciliation[]
  >;
  readonly readCheckoutCleanup: () => Promise<PreparedCheckoutFlowCleanup>;
  readonly reconcile: (candidates: WorkspaceE2ECleanupCandidates) => Promise<A>;
}): Promise<A> => {
  const [checkoutCleanup, accountJournals] = await Promise.all([
    readCheckoutCleanup(),
    readAccountJournals(),
  ]);

  return reconcile({ accountJournals, checkoutCleanup });
};

export const reconcileWorkspaceE2ECheckout = <E, R1, R2>({
  cleanupCheckout,
  reconcileAccountJournals,
}: {
  readonly cleanupCheckout: Effect.Effect<
    WorkspaceE2EError | undefined,
    never,
    R1
  >;
  readonly reconcileAccountJournals: Effect.Effect<void, E, R2>;
}): Effect.Effect<void, WorkspaceE2EError | E, R1 | R2> =>
  cleanupCheckout.pipe(
    Effect.tap(() => reconcileAccountJournals),
    Effect.flatMap((error) => (error ? Effect.fail(error) : Effect.void))
  );

export const traceWorkspaceE2ESuiteCleanup = <R1, R2>({
  reconcileCheckout,
  reconcileUnlimitedPass,
}: {
  readonly reconcileCheckout: Effect.Effect<void, WorkspaceE2EError, R1>;
  readonly reconcileUnlimitedPass: Effect.Effect<void, WorkspaceE2EError, R2>;
}) =>
  Effect.gen(function* () {
    const telemetry = yield* E2ETelemetryService;
    yield* telemetry.tracePhase({
      effect: Effect.gen(function* () {
        const checkout = yield* Effect.result(reconcileCheckout);
        const unlimited = yield* Effect.result(reconcileUnlimitedPass);
        if (Result.isFailure(checkout) && Result.isFailure(unlimited)) {
          return yield* workspaceE2EError("Workspace checkout cleanup failed", {
            causes: [checkout.failure, unlimited.failure],
          });
        }
        if (Result.isFailure(checkout)) return yield* checkout.failure;
        if (Result.isFailure(unlimited)) return yield* unlimited.failure;
      }),
      phaseId: "suite-cleanup",
    });
  });
