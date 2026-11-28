import "@/shared/polyfills/temporal";

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DotyposService } from "@deskohub/dotypos";
import { and, eq, gte, isNull, like, lte } from "drizzle-orm";
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
import { authUser } from "@/db/schema/auth";
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
import { makeWorkspaceE2EAccountRecipientForRunId } from "../account/config";
import {
  prepareWorkspaceE2EAccountLaneReconciliation,
  reconcileWorkspaceE2EAccountJournals,
} from "../account/reconcile";
import { WorkspaceE2EAccountResourceService } from "../account/resources.service";
import {
  issueWorkspaceE2ESyntheticSession,
  resolveWorkspaceE2ESessionSigningSecret,
  workspaceE2ESessionCookieFor,
} from "../account/seeded-session";
import { getWorkspaceE2EDateInterval } from "../capacity";
import {
  assertNexiSandbox,
  type DatasourceConfig,
  getConfig,
  getDatasourceConfig,
} from "../config";
import { type E2EEnvironment, makeE2EEnvironment } from "../e2e-env";
import { E2EDatabase } from "../integrations/database.service";
import {
  getDotyposLayer,
  waitForDotyposCancellationConvergence,
} from "../integrations/dotypos";
import { pollUntil } from "../polling";
import { reservationIntentJournalPath } from "../reservation-intents";
import { readReservationJournal } from "../reservation-journal";
import {
  type WorkspaceE2ERunId,
  workspaceE2ERunIdSchema,
} from "../run-identifiers";
import { assertSafeDatabaseUrl } from "../runtime";
import { withE2ERuntime } from "../runtime-fixture";
import { workspaceE2EPollIntervalMs, workspaceE2ETimeouts } from "../timeouts";
import {
  unlimitedPassAutoRenewalCaseId,
  unlimitedPassAutoRenewalRecipientLabel,
} from "./case-catalog";
import { unlimitedPassAutoRenewalJournalOwner } from "./journal-owners";
import { readWorkspaceE2ERunContext } from "./run-context";
import {
  isUnlimitedPassDayReleased,
  planUnlimitedPassDayRelease,
  readUnlimitedPassCleanupIntent,
  UnlimitedPassCleanupBlocked,
  type UnlimitedPassCleanupIntent,
} from "./unlimited-pass-cleanup-plan";
import {
  checkRecoveryDeployment,
  classifyUnlimitedRecoveryPayment,
  originalUnlimitedRun,
  readCancelledUnlimitedNexiAttempt,
  requireRecovery,
  UnlimitedRecoveryEvidenceRejected,
  verifyUnlimitedRecoveryBuyer,
} from "./unlimited-pass-recovery-evidence";

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

const isProvenUnpaidDay = ({
  row,
  record,
}: ReturnType<typeof planUnlimitedPassDayRelease>[number]) =>
  isUnlimitedPassDayReleased(row)
    ? record?.status === "CANCELLED"
    : record?.status === "NEW" || record?.status === "CANCELLED";

const releaseOwnedPassDays = Effect.fnUntraced(function* (
  purchase: OwnedPurchase,
  intent: UnlimitedPassCleanupIntent,
  config: DatasourceConfig,
  unpaidRecovery = false
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
    catch: (cause) =>
      cause instanceof UnlimitedPassCleanupBlocked
        ? cause
        : new UnlimitedPassCleanupBlocked(
            "Unlimited pass provider ownership could not be verified"
          ),
  });
  if (unpaidRecovery && !days.every(isProvenUnpaidDay)) {
    return yield* Effect.fail(
      new UnlimitedPassCleanupBlocked(
        "A recovered hold was no longer confirmed unpaid"
      )
    );
  }
  const cancellations = yield* Effect.forEach(
    days,
    (day) => {
      const { booking, record, reservationId, row } = day;
      // A captured ID can be missing from a filtered list. The conditional
      // transition checks the current provider booking by ID before writing.
      const cancel =
        reservationId &&
        (unpaidRecovery ||
          (record
            ? record.status !== "CANCELLED"
            : !isUnlimitedPassDayReleased(row)))
          ? setUnlimitedPassDayHoldStatus(
              reservationId,
              booking,
              "CANCELLED",
              unpaidRecovery ? "NEW" : undefined
            ).pipe(
              Effect.catchTag("DotyposRejected", (error) =>
                !unpaidRecovery && error.reason === "not-found"
                  ? Effect.void
                  : Effect.fail(error)
              )
            )
          : Effect.void;
      return Effect.exit(cancel).pipe(
        Effect.map((exit) => (Exit.isSuccess(exit) ? [day] : []))
      );
    },
    { concurrency: 2 }
  );
  const settled = cancellations.flat();
  const reservationIds = [
    ...new Set(
      settled.flatMap(({ reservationId }) =>
        reservationId ? [reservationId] : []
      )
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
  if (unpaidRecovery) {
    const confirmed = planUnlimitedPassDayRelease({
      intent,
      orderId: purchase.id,
      records: yield* lookup,
      rows,
    });
    if (
      settled.length !== days.length ||
      !confirmed.every(
        (day, index) =>
          day.record?.status === "CANCELLED" &&
          day.reservationId === days[index]?.reservationId
      )
    ) {
      return yield* Effect.fail(
        new UnlimitedPassCleanupBlocked(
          "Recovered holds did not converge to exact owned cancellations"
        )
      );
    }
  }
  const now = yield* currentInstant;
  yield* Effect.forEach(
    settled,
    ({ reservationId, row }) => {
      if (isUnlimitedPassDayReleased(row)) return Effect.void;
      // An unbound dispatched POST can still appear in the provider. Keep that
      // claim until the exact hold is observed. Never dispatch another POST.
      if (row.passDayHoldRequestedAt && !reservationId) return Effect.void;
      return endReleasedPassDay(row, reservationId, now);
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
        journal,
      }),
    catch: () =>
      new UnlimitedPassCleanupBlocked(
        "Unlimited pass reservation intent is invalid"
      ),
  });
  const reconcileAccount = account
    ? reconcileWorkspaceE2EAccountJournals([account])
    : Effect.void;
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
      const owned =
        (yield* readOwnedPurchase(intent)) ??
        (yield* Effect.gen(function* () {
          const appeared = yield* readOwnedPurchase(intent);
          // Close this synthetic account before unlocking admission. A delayed
          // Continue must find the tombstone when it takes the buyer lock.
          if (!appeared) yield* reconcileAccount;
          return appeared;
        }).pipe(WorkspaceLockSections.customerAccount(intent.accountId)));
      if (!owned) return;
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
        yield* reconcileAccount;
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
  } else {
    yield* reconcileAccount;
  }
});

const recoverOriginalUnlimitedPass = Effect.fn("recoverOriginalUnlimitedPass")(
  function* (environment: E2EEnvironment, config: DatasourceConfig) {
    const { db } = yield* E2EDatabase;
    const accounts = yield* WorkspaceE2EAccountResourceService;
    const preview = environment.WORKSPACE_E2E_BASE_URL;
    const sha = environment.TARGET_SHA;
    const githubToken = environment.WORKSPACE_E2E_RECOVERY_GITHUB_TOKEN;
    const currentRun = environment.GITHUB_RUN_ID;
    const currentAttempt = environment.GITHUB_RUN_ATTEMPT;
    const vercelToken = environment.WORKSPACE_E2E_VERCEL_TOKEN;
    const bypass = environment.VERCEL_AUTOMATION_BYPASS_SECRET;
    requireRecovery(
      environment.WORKSPACE_E2E_EXECUTION_CONTEXT === "manual" &&
        environment.WORKSPACE_E2E_ALLOCATION_SHARD &&
        environment.WORKSPACE_E2E_PR_NUMBER === 1527 &&
        environment.WORKSPACE_E2E_PAYMENT_PROVIDER === "nexi" &&
        sha &&
        preview &&
        githubToken &&
        currentRun &&
        currentAttempt &&
        vercelToken &&
        bypass,
      "Recovery requires the exact manually leased draft Preview"
    );
    assertSafeDatabaseUrl(
      config.databaseUrlUnpooled,
      "WORKSPACE_E2E_DATABASE_URL_UNPOOLED",
      environment.WORKSPACE_E2E_DATABASE_ALLOWLIST
    );
    assertNexiSandbox(config.nexiApiOrigin);
    yield* Effect.tryPromise({
      try: () =>
        checkRecoveryDeployment({
          githubToken,
          currentRun,
          currentAttempt,
          preview,
          sha,
          vercelToken,
        }),
      catch: () =>
        new UnlimitedPassCleanupBlocked(
          "Recovery repository or deployment provenance was not verified"
        ),
    });

    const recipient = makeWorkspaceE2EAccountRecipientForRunId(
      workspaceE2ERunIdSchema.make(
        `${originalUnlimitedRun.id}-${originalUnlimitedRun.attempt}`
      ),
      unlimitedPassAutoRenewalRecipientLabel
    );
    const candidates = yield* db
      .select({
        purchase: passPurchases,
        account: customerAccounts,
        order: orders,
        authEmail: authUser.email,
      })
      .from(passPurchases)
      .innerJoin(orders, eq(orders.id, passPurchases.id))
      .innerJoin(
        customerAccounts,
        eq(customerAccounts.id, passPurchases.buyerAccountId)
      )
      .leftJoin(authUser, eq(authUser.id, customerAccounts.id))
      .where(
        and(
          eq(passPurchases.product, "unlimited"),
          eq(passPurchases.locale, "en-US"),
          eq(passPurchases.autoRenew, true),
          like(
            passPurchases.buyerAccountId,
            `${unlimitedPassAutoRenewalCaseId}-${unlimitedPassAutoRenewalRecipientLabel}-%`
          ),
          gte(
            passPurchases.createdAt,
            Temporal.Instant.from(originalUnlimitedRun.startedAt)
          ),
          lte(
            passPurchases.createdAt,
            Temporal.Instant.from(originalUnlimitedRun.completedAt)
          )
        )
      )
      .limit(2);
    const [candidate] = candidates;
    requireRecovery(
      candidates.length === 1 && candidate?.order.dotyposCustomerId,
      "Recovery could not match a single original synthetic buyer and order"
    );
    const { account, order, purchase } = candidate;
    const customerId = candidate.order.dotyposCustomerId;
    verifyUnlimitedRecoveryBuyer({
      tombstoned: account.deletedAt !== null,
      linkedCustomerId: account.dotyposCustomerId,
      authEmail: candidate.authEmail,
      customerId,
      recipient,
    });
    const profile = yield* accounts.readCustomerProfile(customerId);
    requireRecovery(
      Option.isSome(profile) &&
        profile.value.email === recipient &&
        (!account.deletedAt ||
          (profile.value.expireDate &&
            new Date(profile.value.expireDate).getTime() <= Date.now())),
      "Recovery synthetic provider profile did not match"
    );
    const firstDay = Temporal.PlainDate.from(purchase.validFrom);
    const endsBefore = Temporal.PlainDate.from(purchase.validUntil);
    requireRecovery(
      firstDay.until(endsBefore).days === 30,
      "Recovery pass period did not match"
    );
    const intent = {
      accountId: account.id,
      customerId,
      firstDay,
      endsBefore,
      interval: getWorkspaceE2EDateInterval({
        fromDate: firstDay.toString(),
        toDate: endsBefore.subtract({ days: 1 }).toString(),
      }),
      orderId: purchase.id,
      paymentStarted: order.activePaymentAttemptId !== null,
      requestedAt: purchase.createdAt.epochMilliseconds,
    } satisfies UnlimitedPassCleanupIntent;

    yield* Effect.gen(function* () {
      const owned = yield* readOwnedPurchase(intent);
      requireRecovery(owned, "Recovery purchase ownership did not match");
      const attempts = yield* db
        .select()
        .from(paymentAttempts)
        .where(eq(paymentAttempts.orderId, purchase.id))
        .limit(2);
      const { attempt, state } = classifyUnlimitedRecoveryPayment({
        paymentState: owned.paymentState,
        purchaseState: owned.status,
        activeAttemptId: owned.paymentAttemptId,
        attempts,
      });
      const rows = yield* readUnlimitedPassDays(purchase.id);
      const providerHolds = yield* listUnlimitedPassDayHolds({
        passId: purchase.id,
        customerId,
        startDate: firstDay,
        endsBefore,
      });
      const planned = planUnlimitedPassDayRelease({
        intent,
        orderId: purchase.id,
        records: providerHolds,
        rows,
      });
      requireRecovery(
        planned.every(isProvenUnpaidDay),
        "Recovery did not confirm every unpaid owned provider hold"
      );
      const readCancellation = Effect.tryPromise({
        try: () =>
          readCancelledUnlimitedNexiAttempt({
            providerOrderId: attempt.providerOrderId ?? "",
            amount: attempt.amountValue,
            vercelToken,
          }),
        catch: () =>
          new UnlimitedPassCleanupBlocked(
            "Exact cancelled zero-money Nexi evidence was unavailable"
          ),
      });
      const handoff = URL.parse(attempt.providerRedirectUrl ?? "");
      requireRecovery(
        attempt.createdAt.epochMilliseconds >=
          Date.parse(originalUnlimitedRun.startedAt) &&
          attempt.createdAt.epochMilliseconds <=
            Date.parse(originalUnlimitedRun.completedAt) &&
          handoff?.origin === "https://xpaysandbox.nexigroup.com" &&
          handoff.pathname.startsWith("/hpp/"),
        "Recovery attempt was not created in the original run"
      );
      const operationId = yield* readCancellation;
      if (state === "cancelled") {
        requireRecovery(
          attempt.lastProviderOperationId === operationId,
          "Stored terminal attempt did not match Nexi"
        );
      }
      yield* Effect.tryPromise({
        try: async () => {
          const directory = await mkdtemp(
            join(tmpdir(), "workspace-unlimited-recovery-")
          );
          await writeFile(
            join(directory, "ownership.json"),
            JSON.stringify({
              originalRun: originalUnlimitedRun.id,
              orderId: purchase.id,
              customerAccountId: account.id,
              attemptId: attempt.id,
              providerOperationId: operationId,
            }),
            { mode: 0o600 }
          );
        },
        catch: () =>
          new UnlimitedPassCleanupBlocked(
            "Private recovery ownership receipt could not be saved"
          ),
      });
      if (state === "pending") {
        requireRecovery(
          !account.deletedAt,
          "Pending recovery buyer has no active account"
        );
        const value = yield* issueWorkspaceE2ESyntheticSession({
          accountId: account.id,
          secret: resolveWorkspaceE2ESessionSigningSecret(environment),
        });
        yield* Effect.tryPromise({
          try: async () => {
            const cookie = workspaceE2ESessionCookieFor(preview);
            const response = await fetch(
              new URL(
                `/en-US/reservation/status/${encodeURIComponent(purchase.id)}`,
                preview
              ),
              {
                headers: {
                  Cookie: `${cookie.name}=${value}`,
                  "x-vercel-protection-bypass": bypass,
                },
                redirect: "error",
                signal: AbortSignal.timeout(
                  workspaceE2ETimeouts.providerTransition
                ),
              }
            );
            requireRecovery(response.ok, "Owned buyer status refresh failed");
            await response.arrayBuffer();
          },
          catch: () =>
            new UnlimitedPassCleanupBlocked(
              "Owned buyer status refresh did not complete"
            ),
        });
      }
      yield* Effect.gen(function* () {
        const current = yield* readOwnedPurchase(intent);
        requireRecovery(
          current,
          "Recovery purchase no longer matched its owner"
        );
        const currentAttempts = yield* db
          .select()
          .from(paymentAttempts)
          .where(eq(paymentAttempts.orderId, purchase.id))
          .limit(2);
        const terminal = classifyUnlimitedRecoveryPayment({
          paymentState: current.paymentState,
          purchaseState: current.status,
          activeAttemptId: current.paymentAttemptId,
          attempts: currentAttempts,
        });
        requireRecovery(
          terminal.state === "cancelled" &&
            terminal.attempt.id === attempt.id &&
            terminal.attempt.providerOrderId === attempt.providerOrderId &&
            terminal.attempt.amountValue === attempt.amountValue &&
            terminal.attempt.lastProviderOperationId === operationId,
          "Application did not verify the exact terminal payment"
        );
        const readBuyerState = Effect.gen(function* () {
          const [buyer] = yield* db
            .select({
              deletedAt: customerAccounts.deletedAt,
              linkedCustomerId: customerAccounts.dotyposCustomerId,
              authEmail: authUser.email,
            })
            .from(customerAccounts)
            .leftJoin(authUser, eq(authUser.id, customerAccounts.id))
            .where(eq(customerAccounts.id, account.id));
          requireRecovery(buyer, "Recovery buyer could not be read");
          return verifyUnlimitedRecoveryBuyer({
            tombstoned: buyer.deletedAt !== null,
            linkedCustomerId: buyer.linkedCustomerId,
            authEmail: buyer.authEmail,
            customerId,
            recipient,
          });
        });
        const buyer = yield* readBuyerState;
        requireRecovery(
          buyer.expireProfile || account.deletedAt,
          "Recovery buyer changed after provider profile verification"
        );
        requireRecovery(
          (yield* readCancellation) === operationId,
          "The verified Nexi operation changed before release"
        );
        yield* releaseOwnedPassDays(current, intent, config, true);
        if (buyer.expireProfile) yield* accounts.expireProfile(customerId);
        if (buyer.removeLogin) yield* accounts.removeAuthUser(account.id);
        const settledBuyer = yield* readBuyerState;
        requireRecovery(
          !settledBuyer.expireProfile && !settledBuyer.removeLogin,
          "Recovery buyer cleanup could not be verified"
        );
      }).pipe(
        holdCustomerAccountAndPassPurchase(account.id, owned.id),
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
);

// Playwright launches this server-only entry point for the opted-in journals.
// The separately admitted recovery uses only verified durable ownership.
if (import.meta.main) {
  try {
    const environment = makeE2EEnvironment();
    getConfig(environment);
    const config = getDatasourceConfig(environment);
    const reconcile = environment.WORKSPACE_E2E_RECOVER_UNLIMITED_RUN
      ? recoverOriginalUnlimitedPass(environment, config)
      : reconcileUnlimitedPass(
          config,
          (await readWorkspaceE2ERunContext()).runId
        );
    const exit = await withE2ERuntime(
      {
        layer: Layer.mergeAll(
          WorkspaceE2EAccountResourceService.layerWithDatabase(config),
          Logger.layer([])
        ),
      },
      (runEffect) => runEffect(Effect.exit(reconcile))
    );
    if (Exit.isFailure(exit)) {
      const error = environment.WORKSPACE_E2E_RECOVER_UNLIMITED_RUN
        ? Cause.squash(exit.cause)
        : Option.getOrUndefined(Cause.findErrorOption(exit.cause));
      const fallback = environment.WORKSPACE_E2E_RECOVER_UNLIMITED_RUN
        ? "Original Unlimited recovery could not complete"
        : "Unlimited pass cleanup failed while reconciling its journals";
      process.stderr.write(
        `${
          error instanceof UnlimitedPassCleanupBlocked ||
          error instanceof UnlimitedRecoveryEvidenceRejected
            ? error.message
            : fallback
        }\n`
      );
      process.exitCode = 1;
    } else if (environment.WORKSPACE_E2E_RECOVER_UNLIMITED_RUN) {
      process.stdout.write("Original Unlimited fixture recovery converged\n");
    }
  } catch {
    process.stderr.write("Unlimited pass cleanup could not start\n");
    process.exitCode = 1;
  }
}
