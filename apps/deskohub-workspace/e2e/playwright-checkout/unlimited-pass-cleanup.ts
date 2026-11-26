import "@/shared/polyfills/temporal";

import { DotyposService } from "@deskohub/dotypos";
import { and, eq, isNull } from "drizzle-orm";
import { Cause, Effect, Exit, Layer, Logger, Option } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { WorkspaceDatabaseAdvisoryLock } from "@/db/postgres-advisory-lock";
import {
  customerAccounts,
  orders,
  passPurchases,
  paymentAttempts,
  unlimitedPassDayMoves,
  workspaceReservations,
} from "@/db/schema";
import {
  holdCustomerAccountAndPassPurchase,
  WorkspaceLockSections,
} from "@/db/workspace-locks";
import { endReleasedPassDay } from "@/features/passes/backend/unlimited-pass-day-transitions";
import {
  listUnlimitedPassDayHolds,
  setUnlimitedPassDayHoldStatus,
} from "@/features/passes/backend/unlimited-pass-dotypos-holds";
import { readUnlimitedPassDays } from "@/features/passes/backend/unlimited-pass-holds";
import { currentInstant } from "@/shared/utils/temporal";
import {
  prepareWorkspaceE2EAccountLaneReconciliation,
  reconcileWorkspaceE2EAccountJournals,
} from "../account/reconcile";
import { WorkspaceE2EAccountResourceService } from "../account/resources.service";
import {
  type DatasourceConfig,
  getConfig,
  getDatasourceConfig,
} from "../config";
import { makeE2EEnvironment } from "../e2e-env";
import { E2EDatabase } from "../integrations/database.service";
import {
  getDotyposLayer,
  waitForDotyposCancellationConvergence,
} from "../integrations/dotypos";
import { pollUntil } from "../polling";
import { reservationIntentJournalPath } from "../reservation-intents";
import { readReservationJournal } from "../reservation-journal";
import type { WorkspaceE2ERunId } from "../run-identifiers";
import { withE2ERuntime } from "../runtime-fixture";
import { workspaceE2EPollIntervalMs, workspaceE2ETimeouts } from "../timeouts";
import { unlimitedPassAutoRenewalCaseId } from "./case-catalog";
import { unlimitedPassAutoRenewalJournalOwner } from "./journal-owners";
import { readWorkspaceE2ERunContext } from "./run-context";
import {
  isUnlimitedPassDayReleased,
  planUnlimitedPassDayRelease,
  readUnlimitedPassCleanupIntent,
  UnlimitedPassCleanupBlocked,
  type UnlimitedPassCleanupIntent,
} from "./unlimited-pass-cleanup-plan";

const readOwnedPurchase = Effect.fnUntraced(function* (
  intent: UnlimitedPassCleanupIntent
) {
  const { db } = yield* WorkspaceDatabase;
  const [account] = yield* db
    .select({
      customerId: customerAccounts.dotyposCustomerId,
      deletedAt: customerAccounts.deletedAt,
    })
    .from(customerAccounts)
    .where(eq(customerAccounts.id, intent.accountId));
  if (
    !account ||
    (!account.deletedAt && account.customerId !== intent.customerId)
  ) {
    return yield* Effect.fail(
      new UnlimitedPassCleanupBlocked(
        "Unlimited pass buyer is not linked to the synthetic customer"
      )
    );
  }
  const [owned, extra] = yield* db
    .select({
      customerId: orders.dotyposCustomerId,
      holder: passPurchases.holderAccountId,
      id: passPurchases.id,
      kind: orders.kind,
      paymentAttemptId: orders.activePaymentAttemptId,
      paymentState: orders.paymentState,
      product: passPurchases.product,
      renewsPassId: passPurchases.renewsPassId,
      status: passPurchases.status,
      tier: passPurchases.tier,
      validFrom: passPurchases.validFrom,
      validUntil: passPurchases.validUntil,
    })
    .from(passPurchases)
    .innerJoin(orders, eq(orders.id, passPurchases.id))
    .where(eq(passPurchases.buyerAccountId, intent.accountId))
    .limit(2);
  if (
    extra ||
    (intent.orderId && owned?.id !== intent.orderId) ||
    (owned &&
      (owned.customerId !== intent.customerId ||
        owned.holder !== intent.accountId ||
        owned.kind !== "pass-purchase" ||
        owned.product !== "unlimited" ||
        owned.tier !== "open-space" ||
        owned.renewsPassId !== null ||
        owned.validFrom !== intent.firstDay.toString() ||
        owned.validUntil !== intent.endsBefore.toString()))
  ) {
    return yield* Effect.fail(
      new UnlimitedPassCleanupBlocked(
        "Unlimited pass order ownership did not match"
      )
    );
  }
  return owned;
});

type OwnedPurchase = NonNullable<
  Effect.Success<ReturnType<typeof readOwnedPurchase>>
>;

const isPaidAndActive = (purchase: OwnedPurchase) =>
  purchase.paymentState === "paid" &&
  purchase.status === "active" &&
  purchase.paymentAttemptId !== null;

const paymentCanStillChangeHolds = () =>
  new UnlimitedPassCleanupBlocked(
    "Unlimited pass payment or fulfillment can still change the holds"
  );

const requireSettledPayment = Effect.fnUntraced(function* (
  purchase: OwnedPurchase,
  intent: UnlimitedPassCleanupIntent
) {
  const { db } = yield* WorkspaceDatabase;
  if (isPaidAndActive(purchase)) return;
  const [attempt] = yield* db
    .select({ id: paymentAttempts.id })
    .from(paymentAttempts)
    .where(eq(paymentAttempts.orderId, purchase.id))
    .limit(1);
  if (
    intent.paymentStarted ||
    attempt ||
    purchase.paymentAttemptId ||
    (purchase.paymentState !== "not_started" &&
      purchase.paymentState !== "expired") ||
    (purchase.status !== "pending_payment" && purchase.status !== "void")
  ) {
    return yield* Effect.fail(paymentCanStillChangeHolds());
  }
});

const releaseOwnedPassDays = Effect.fnUntraced(function* (
  purchase: OwnedPurchase,
  intent: UnlimitedPassCleanupIntent,
  config: DatasourceConfig
) {
  const { db } = yield* WorkspaceDatabase;
  const dotypos = yield* DotyposService;
  // A move can own an additional provider hold and capacity claim outside
  // the current day rows. The fulfillment lock prevents a new move here.
  const [pendingMove] = yield* db
    .select({ generation: unlimitedPassDayMoves.generation })
    .from(unlimitedPassDayMoves)
    .innerJoin(
      workspaceReservations,
      eq(workspaceReservations.id, unlimitedPassDayMoves.reservationId)
    )
    .where(
      and(
        eq(workspaceReservations.passId, purchase.id),
        isNull(unlimitedPassDayMoves.settledAt)
      )
    )
    .limit(1);
  if (pendingMove) {
    return yield* Effect.fail(
      new UnlimitedPassCleanupBlocked(
        "Unlimited pass has an unresolved day move"
      )
    );
  }
  const lookup = listUnlimitedPassDayHolds({
    passId: purchase.id,
    customerId: intent.customerId,
    startDate: intent.firstDay,
    endsBefore: intent.endsBefore,
  });
  const rows = yield* readUnlimitedPassDays(purchase.id);
  const records = yield* lookup;
  const days = yield* Effect.try({
    try: () =>
      planUnlimitedPassDayRelease({
        intent,
        orderId: purchase.id,
        records,
        rows,
      }),
    catch: (cause) => cause,
  });
  const cancellations = yield* Effect.forEach(
    days,
    (day) =>
      Effect.exit(
        day.record?.id && day.record.status !== "CANCELLED"
          ? setUnlimitedPassDayHoldStatus(
              day.record.id,
              day.booking,
              "CANCELLED"
            )
          : Effect.void
      ).pipe(Effect.map((exit) => (Exit.isSuccess(exit) ? [day] : []))),
    { concurrency: 2 }
  );
  const settled = cancellations.flat();
  const reservationIds = [
    ...new Set(
      settled.flatMap(({ record, row }) => {
        const id = record?.id ?? row.dotyposReservationId;
        return id ? [id] : [];
      })
    ),
  ];
  if (reservationIds.length > 0) {
    yield* waitForDotyposCancellationConvergence(
      dotypos.listActiveReservationsOverlapping(intent.interval),
      reservationIds,
      {
        intervalMs: workspaceE2EPollIntervalMs.datasource,
        timeoutMs: config.timeouts.datasource,
      }
    );
  }
  const now = yield* currentInstant;
  yield* Effect.forEach(
    settled,
    ({ record, row }) => {
      const releasedId = record?.id ?? row.dotyposReservationId ?? undefined;
      if (isUnlimitedPassDayReleased(row)) return Effect.void;
      // An unbound dispatched POST can still appear in the provider. Keep that
      // claim until the exact hold is observed. Never dispatch another POST.
      if (row.passDayHoldRequestedAt && !releasedId) return Effect.void;
      return endReleasedPassDay(row, releasedId, now);
    },
    { discard: true }
  );

  if (settled.length !== days.length) {
    return yield* Effect.fail(
      new UnlimitedPassCleanupBlocked(
        "Unlimited pass provider cancellation did not settle"
      )
    );
  }
  const remaining = yield* readUnlimitedPassDays(purchase.id);
  if (
    remaining.length !== days.length ||
    !remaining.every(isUnlimitedPassDayReleased)
  ) {
    return yield* Effect.fail(
      new UnlimitedPassCleanupBlocked(
        "Unlimited pass still has unresolved capacity claims"
      )
    );
  }
  if ((yield* lookup).some(({ status }) => status !== "CANCELLED")) {
    return yield* Effect.fail(
      new UnlimitedPassCleanupBlocked(
        "Unlimited pass still has active provider holds"
      )
    );
  }
});

const reconcileUnlimitedPass = Effect.fnUntraced(function* (
  config: DatasourceConfig,
  runId: WorkspaceE2ERunId
) {
  const journalPath = reservationIntentJournalPath(
    unlimitedPassAutoRenewalCaseId
  );
  if (!journalPath) {
    return yield* Effect.fail(
      new UnlimitedPassCleanupBlocked(
        "Unlimited pass cleanup journal path is unavailable"
      )
    );
  }
  const journal = yield* Effect.tryPromise(() =>
    readReservationJournal(journalPath)
  );
  const account = yield* prepareWorkspaceE2EAccountLaneReconciliation(
    config,
    runId,
    unlimitedPassAutoRenewalJournalOwner
  );
  if (account?.journal.dotyposReservationIds.length) {
    return yield* Effect.fail(
      new UnlimitedPassCleanupBlocked(
        "Unlimited pass account journal unexpectedly names reservations"
      )
    );
  }
  const intent = yield* Effect.try({
    try: () =>
      readUnlimitedPassCleanupIntent({
        account,
        runId,
        value: journal?.reservationIntents,
      }),
    catch: () =>
      new UnlimitedPassCleanupBlocked(
        "Unlimited pass reservation intent is invalid"
      ),
  });
  if (intent) {
    // Pay cannot load until the Continue action returns. With no response,
    // budget the click, the deployed action, and its last provider request.
    if (!intent.orderId) {
      yield* Effect.sleep(
        Math.max(
          0,
          intent.requestedAt +
            workspaceE2ETimeouts.browserAction +
            workspaceE2ETimeouts.unlimitedPassCheckoutStart +
            config.dotypos.apiTimeout -
            Date.now()
        )
      );
    }
    const { db } = yield* E2EDatabase;
    yield* Effect.gen(function* () {
      const owned = yield* readOwnedPurchase(intent);
      if (!owned) {
        yield* Effect.gen(function* () {
          if (yield* readOwnedPurchase(intent)) {
            return yield* Effect.fail(
              new UnlimitedPassCleanupBlocked(
                "Unlimited pass order appeared during cleanup"
              )
            );
          }
        }).pipe(WorkspaceLockSections.customerAccount(intent.accountId));
        return;
      }
      if (
        (intent.paymentStarted || owned.paymentAttemptId) &&
        !isPaidAndActive(owned)
      ) {
        // Give a genuine sandbox webhook time to finish before taking the
        // same locks its fulfillment needs. An unpaid attempt can still pay.
        yield* pollUntil(
          readOwnedPurchase(intent).pipe(
            Effect.map((purchase) =>
              purchase && isPaidAndActive(purchase) ? true : undefined
            )
          ),
          {
            intervalMs: workspaceE2EPollIntervalMs.datasource,
            label: "Unlimited pass payment and fulfillment to settle",
            timeoutMs: config.timeouts.providerTransition,
          }
        ).pipe(Effect.mapError(paymentCanStillChangeHolds));
      }
      yield* Effect.gen(function* () {
        const locked = yield* readOwnedPurchase(intent);
        if (!locked || locked.id !== owned.id) {
          return yield* Effect.fail(
            new UnlimitedPassCleanupBlocked(
              "Unlimited pass order changed during cleanup"
            )
          );
        }
        yield* requireSettledPayment(locked, intent);
        yield* releaseOwnedPassDays(locked, intent, config);
      }).pipe(
        holdCustomerAccountAndPassPurchase(intent.accountId, owned.id),
        WorkspaceLockSections.unlimitedPassRecovery(owned.id)
      );
    }).pipe(
      Effect.provide(getDotyposLayer(config)),
      Effect.provideService(WorkspaceDatabase, WorkspaceDatabase.make(db)),
      Effect.provideService(
        WorkspaceDatabaseAdvisoryLock,
        WorkspaceDatabaseAdvisoryLock.make({
          client: db.$client,
          maxConnections: 2,
        })
      )
    );
  }
  if (account) yield* reconcileWorkspaceE2EAccountJournals([account]);
});

// Playwright launches this server-only entry point only for the opted-in
// case's journals. Print fixed messages only, including for dependency errors.
if (import.meta.main) {
  try {
    const environment = makeE2EEnvironment();
    getConfig(environment);
    const config = getDatasourceConfig(environment);
    const { runId } = await readWorkspaceE2ERunContext();
    const exit = await withE2ERuntime(
      {
        layer: Layer.mergeAll(
          WorkspaceE2EAccountResourceService.layerWithDatabase(config),
          Logger.layer([])
        ),
      },
      (runEffect) =>
        runEffect(Effect.exit(reconcileUnlimitedPass(config, runId)))
    );
    if (Exit.isFailure(exit)) {
      const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
      process.stderr.write(
        `${error instanceof UnlimitedPassCleanupBlocked ? error.message : "Unlimited pass cleanup failed while reconciling its journals"}\n`
      );
      process.exitCode = 1;
    }
  } catch {
    process.stderr.write("Unlimited pass cleanup could not start\n");
    process.exitCode = 1;
  }
}
