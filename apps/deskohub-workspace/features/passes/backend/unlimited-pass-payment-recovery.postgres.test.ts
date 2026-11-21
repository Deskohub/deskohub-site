import "@/shared/testing/workspace-test-env";

import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  DotyposCustomerIdSchema,
  DotyposRejected,
  DotyposService,
  DotyposTableIdSchema,
  DotyposTableSchema,
} from "@deskohub/dotypos";
import { makeInMemoryDotypos } from "@deskohub/dotypos/testing";
import { EmailConfigTag, EmailServiceTag } from "@deskohub/email";
import { eq } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";
import { WorkspaceDatabase } from "@/db/database.service";
import { WorkspaceDatabaseAdvisoryLock } from "@/db/postgres-advisory-lock";
import {
  customerAccounts,
  orders,
  passPurchases,
  paymentAttempts,
} from "@/db/schema";
import { CustomerAccountSections } from "@/features/account/backend/customer-account-sections";
import { customerAccountIdSchema } from "@/features/account/customer-account";
import { AccountingDocumentSnapshots } from "@/features/accounting/backend/accounting-document-snapshots";
import { InvoiceRepository } from "@/features/accounting/backend/invoice.repository";
import { InvoiceEmailDeliveryRepository } from "@/features/accounting/backend/invoice-email-delivery.repository";
import { InvoiceEmailDeliveryService } from "@/features/accounting/backend/invoice-email-delivery.service";
import { OrderPaymentHandlers } from "@/features/checkout/backend/payment/order-payment-handlers.service";
import { PaymentProviders } from "@/features/checkout/backend/payment/payment-provider";
import { ProviderPaymentFinalizationService } from "@/features/checkout/backend/payment/provider-payment-finalization.service";
import { paymentAttemptIdSchema } from "@/features/checkout/checkout-identifiers";
import { orderIdSchema } from "@/features/order";
import { GoogleCalendarWorkspaceLimitationsService } from "@/features/reservation/backend/google-calendar-workspace-limitations.service";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import { getCoworkReservationInterval } from "@/features/reservation/cowork-reservation";
import { getCurrentWorkspaceDate } from "@/features/reservation/reservation-date";
import { currencyCZK } from "@/shared/money/currencies";
import {
  createWorkspacePostgresSuiteDatabase,
  type WorkspacePostgresSuiteDatabase,
} from "@/shared/testing/workspace-postgres-test-database.test-utils";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import { unlimitedPassDays } from "../pass-offer";
import { makeEntryPackOrderPaymentHandler } from "./entry-pack-order-payment-handler";
import {
  canConfirmUnlimitedPass,
  settlePassPurchase,
} from "./entry-pack-settlement";
import {
  reconcilePassPurchases,
  reconcileUnlimitedPassReleases,
} from "./pass-purchase-reconciliation";
import {
  confirmUnlimitedPassDays,
  createUnlimitedPassHolds,
  readUnlimitedPassDays,
} from "./unlimited-pass-holds";
import { recordUnlimitedPassOrder } from "./unlimited-pass-orders";

let database: WorkspacePostgresSuiteDatabase | null;
beforeAll(async () => {
  database = await createWorkspacePostgresSuiteDatabase(
    "unlimited_payment_recovery"
  );
});
afterAll(async () => {
  await database?.close();
});

const it = test.skipIf(!process.env.WORKSPACE_TEST_DATABASE_URL);
const customerId = DotyposCustomerIdSchema.make("123");
const tableId = DotyposTableIdSchema.make("42");
const table = Schema.decodeUnknownSync(DotyposTableSchema)({
  id: tableId,
  _cloudId: "1",
  display: true,
  enabled: true,
  name: "Synthetic reserved desk",
  seats: "1",
  tags: ["cowork:reserved-desk"],
});
const provider = makeInMemoryDotypos({ tables: [table] });
const date = (day: Temporal.PlainDate) =>
  plainDateStringSchema.make(day.toString());
const price = currencyCZK(599_000);

const recordPurchase = (
  now: Temporal.Instant,
  startDaysAhead = 10,
  tier: "reserved-desk" | "open-space" = "reserved-desk"
) =>
  Effect.gen(function* () {
    const { db, transaction } = yield* WorkspaceDatabase;
    const accountId = customerAccountIdSchema.make(crypto.randomUUID());
    yield* db.insert(customerAccounts).values({ id: accountId });
    const start = getCurrentWorkspaceDate(now).add({ days: startDaysAhead });
    return yield* transaction(
      recordUnlimitedPassOrder({
        orderId: orderIdSchema.make(crypto.randomUUID()),
        locale: "en-US",
        buyer: { accountId, customerId },
        holder: { accountId, customerId },
        createdAt: now,
        selection:
          tier === "open-space"
            ? { startDate: date(start), tier, coffee: false }
            : { startDate: date(start), tier },
        quote: {
          product: { kind: "unlimited", tier },
          discountableSubtotal: price,
          discountedSubtotal: price,
          totalDiscount: currencyCZK(0),
          discounts: [],
        },
        days: Array.from({ length: unlimitedPassDays }, (_, offset) => ({
          serviceDate: date(start.add({ days: offset })),
          tableId,
        })),
      })
    );
  });

const readState = (orderId: typeof orders.$inferSelect.id) =>
  Effect.gen(function* () {
    const { db } = yield* WorkspaceDatabase;
    const [order] = yield* db
      .select()
      .from(orders)
      .where(eq(orders.id, orderId));
    const [purchase] = yield* db
      .select()
      .from(passPurchases)
      .where(eq(passPurchases.id, orderId));
    const attempts = yield* db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.orderId, orderId));
    return { order, purchase, attempts };
  });

const recordAttempt = (
  orderId: typeof orders.$inferSelect.id,
  state: "expired" | "paid",
  now: Temporal.Instant
) =>
  Effect.gen(function* () {
    const { db } = yield* WorkspaceDatabase;
    const id = paymentAttemptIdSchema.make(crypto.randomUUID());
    yield* db.insert(paymentAttempts).values({
      id,
      orderId,
      provider: "nexi",
      providerOrderId: id,
      state,
      failureCode: state === "expired" ? "fixture_expired" : null,
      amountValue: price.value,
      amountExponent: 2,
      currency: "CZK",
      updatedAt: now,
    });
    return id;
  });

const servicesFor = (dotypos: typeof DotyposService.Service) =>
  Layer.mergeAll(
    database!.layer,
    WorkspaceDatabaseAdvisoryLock.makeLayer(database!.databasePool),
    Layer.succeed(DotyposService, dotypos),
    WorkspaceReservationRepository.Default.pipe(Layer.provide(database!.layer)),
    Layer.mock(GoogleCalendarWorkspaceLimitationsService, {
      listLimitations: () => Effect.succeed([]),
    }),
    Layer.mock(CustomerAccountSections, {}),
    Layer.mock(EmailConfigTag, {}),
    Layer.mock(EmailServiceTag, {}),
    Layer.mock(AccountingDocumentSnapshots, {
      findPassPurchase: () => Effect.undefined,
    }),
    Layer.mock(InvoiceRepository, { issueEntryPack: () => Effect.undefined }),
    Layer.mock(InvoiceEmailDeliveryService, {}),
    Layer.mock(InvoiceEmailDeliveryRepository, {}),
    Layer.mock(PaymentProviders, { activeProviders: ["nexi"] }),
    Layer.mock(ProviderPaymentFinalizationService, {})
  );

const withInterruptedHoldRead = (service: typeof DotyposService.Service) => {
  let interruptRead = true;
  return {
    ...service,
    getReservationsByIds: (ids, options) =>
      Effect.suspend(() => {
        if (!interruptRead) return service.getReservationsByIds(ids, options);
        interruptRead = false;
        return Effect.fail(
          new DotyposRejected({
            operation: "getReservationsByIds",
            reason: "invalid-response",
          })
        );
      }),
  } satisfies typeof DotyposService.Service;
};

it("recovers a verified capture after an interrupted read of replacement holds", async () => {
  const now = Temporal.Now.instant().round({ smallestUnit: "millisecond" });
  const purchase = await Effect.runPromise(
    recordPurchase(now).pipe(Effect.provide(database!.layer))
  );
  const services = servicesFor(
    withInterruptedHoldRead({
      ...provider.service,
      getTables: () =>
        Effect.gen(function* () {
          const { attempts, order } = yield* readState(purchase.id).pipe(
            Effect.provide(database!.layer)
          );
          expect(attempts[0]).toMatchObject({
            state: "paid",
            refundState: "not_required",
            lastProviderOperationId: "verified-operation",
          });
          expect(order?.paidAt?.toString()).toBe(now.toString());
          return yield* provider.service.getTables();
        }),
    })
  );

  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* WorkspaceDatabase;
      const attemptId = yield* recordAttempt(purchase.id, "expired", now);
      yield* db
        .update(orders)
        .set({ paymentState: "expired", activePaymentAttemptId: attemptId })
        .where(eq(orders.id, purchase.id));
      yield* settlePassPurchase(purchase.id);
      const handler = yield* makeEntryPackOrderPaymentHandler;
      const interrupted = yield* Effect.result(
        handler.startRecovery({
          orderId: purchase.id,
          paymentAttemptId: attemptId,
          providerOperationId: "verified-operation",
          providerStatus: "EXECUTED",
          verifiedPaidAt: now,
        })
      );
      expect(interrupted).toMatchObject({
        failure: { _tag: "DotyposRejected", operation: "getReservationsByIds" },
      });
      const recorded = yield* readState(purchase.id);
      expect(recorded.order?.paymentState).toBe("expired");
      expect(recorded.purchase?.status).toBe("pending_payment");
      const replacementDays = yield* readUnlimitedPassDays(purchase.id);
      expect(
        replacementDays.every(
          ({ reservationState }) => reservationState === "held"
        )
      ).toBe(true);
      expect(yield* reconcileUnlimitedPassReleases({ now, limit: 2 })).toBe(0);

      // A back-office unsolicited partial refund preserves the accepted
      // purchase and must not replace the verified capture timestamp.
      const refundAt = now.add({ minutes: 1 });
      yield* db
        .update(paymentAttempts)
        .set({
          refundState: "refunded",
          refundedAmountValue: 100_000,
          refundedAt: refundAt,
          updatedAt: refundAt,
        })
        .where(eq(paymentAttempts.id, attemptId));

      const registry = OrderPaymentHandlers.make(
        { "pass-purchase": handler },
        () => Effect.succeed("pass-purchase")
      );
      expect(
        yield* reconcilePassPurchases({
          now: now.add({ minutes: 6 }),
          limit: 1,
        }).pipe(Effect.provideService(OrderPaymentHandlers, registry))
      ).toMatchObject({ recoveriesRetried: 1 });
      const recovered = yield* readState(purchase.id);
      expect(recovered.order?.paymentState).toBe("paid");
      expect(recovered.order?.paidAt?.toString()).toBe(now.toString());
      expect(recovered.purchase?.status).toBe("active");
      expect(recovered.attempts[0]).toMatchObject({
        refundState: "refunded",
        refundedAmountValue: 100_000,
        refundTargetValue: null,
      });
      const confirmed = yield* readUnlimitedPassDays(purchase.id);
      expect(confirmed.map(({ reservationState }) => reservationState)).toEqual(
        Array(unlimitedPassDays).fill("confirmed")
      );
      expect(
        confirmed.map(({ dotyposReservationId }) => dotyposReservationId)
      ).toEqual(
        replacementDays.map(({ dotyposReservationId }) => dotyposReservationId)
      );
    }).pipe(Effect.provide(services))
  );
});

it("requires a full refund for a verified superseded attempt without touching the winning attempt", async () => {
  const now = Temporal.Now.instant();
  const initialRecords = provider.reservations.size;
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* WorkspaceDatabase;
      const purchase = yield* recordPurchase(now);
      const oldId = yield* recordAttempt(purchase.id, "expired", now);
      const newId = yield* recordAttempt(purchase.id, "expired", now);
      yield* db
        .update(orders)
        .set({ paymentState: "expired", activePaymentAttemptId: newId })
        .where(eq(orders.id, purchase.id));
      yield* settlePassPurchase(purchase.id);
      const handler = yield* makeEntryPackOrderPaymentHandler;
      yield* handler.startRecovery({
        orderId: purchase.id,
        paymentAttemptId: oldId,
        providerOperationId: "late-old-operation",
        verifiedPaidAt: now,
      });
      const recovered = yield* readState(purchase.id);
      expect(recovered.order).toMatchObject({
        paymentState: "expired",
        activePaymentAttemptId: newId,
      });
      expect(recovered.attempts.find(({ id }) => id === oldId)).toMatchObject({
        state: "paid",
        refundState: "required",
        refundTargetValue: price.value,
      });
      expect(recovered.attempts.find(({ id }) => id === newId)?.state).toBe(
        "expired"
      );
      expect(provider.reservations.size).toBe(initialRecords);
    }).pipe(Effect.provide(servicesFor(provider.service)))
  );
});

it("preserves legacy full refund obligations after a partial refund record", async () => {
  const now = Temporal.Now.instant();
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* WorkspaceDatabase;
      const purchase = yield* recordPurchase(now, 225);
      const attemptId = yield* recordAttempt(purchase.id, "paid", now);
      yield* db
        .update(orders)
        .set({
          paymentState: "expired",
          activePaymentAttemptId: attemptId,
        })
        .where(eq(orders.id, purchase.id));
      yield* settlePassPurchase(purchase.id);
      yield* db
        .update(paymentAttempts)
        .set({
          refundState: "refunded",
          refundedAmountValue: 100_000,
          refundedAt: now,
        })
        .where(eq(paymentAttempts.id, attemptId));
      const recordsBefore = provider.reservations.size;
      const handler = yield* makeEntryPackOrderPaymentHandler;
      const registry = OrderPaymentHandlers.make(
        { "pass-purchase": handler },
        () => Effect.succeed("pass-purchase")
      );
      expect(
        yield* reconcilePassPurchases({
          now: now.add({ minutes: 6 }),
          limit: 1,
        }).pipe(Effect.provideService(OrderPaymentHandlers, registry))
      ).toMatchObject({ recoveriesRetried: 1 });
      const rejected = yield* readState(purchase.id);
      expect(rejected.order).toMatchObject({
        paymentState: "expired",
        paidAt: null,
      });
      expect(rejected.purchase?.status).toBe("void");
      expect(rejected.attempts[0]).toMatchObject({
        state: "paid",
        refundState: "required",
        refundTargetValue: price.value,
        refundedAmountValue: 100_000,
      });
      expect(provider.reservations.size).toBe(recordsBefore);
    }).pipe(Effect.provide(servicesFor(provider.service)))
  );
});

it("requires a full refund when the original holder cannot be readmitted", async () => {
  const now = Temporal.Now.instant();
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* WorkspaceDatabase;
      const purchase = yield* recordPurchase(now, 90);
      const attemptId = yield* recordAttempt(purchase.id, "expired", now);
      yield* db
        .update(orders)
        .set({ paymentState: "expired", activePaymentAttemptId: attemptId })
        .where(eq(orders.id, purchase.id));
      yield* settlePassPurchase(purchase.id);
      yield* db
        .update(customerAccounts)
        .set({ deletedAt: now })
        .where(eq(customerAccounts.id, purchase.holderAccountId));
      const recordsBefore = provider.reservations.size;
      const handler = yield* makeEntryPackOrderPaymentHandler;
      yield* handler.startRecovery({
        orderId: purchase.id,
        paymentAttemptId: attemptId,
        verifiedPaidAt: now,
      });
      const rejected = yield* readState(purchase.id);
      expect(rejected.order?.paymentState).toBe("expired");
      expect(rejected.purchase?.status).toBe("void");
      expect(rejected.attempts[0]).toMatchObject({
        state: "paid",
        refundState: "required",
        refundTargetValue: price.value,
      });
      expect(provider.reservations.size).toBe(recordsBefore);
    }).pipe(Effect.provide(servicesFor(provider.service)))
  );
});

it("requires a full refund when the holder is deleted after replacement holds are stored", async () => {
  const now = Temporal.Now.instant();
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* WorkspaceDatabase;
      const purchase = yield* recordPurchase(now, 150);
      const attemptId = yield* recordAttempt(purchase.id, "expired", now);
      yield* db
        .update(orders)
        .set({
          paymentState: "expired",
          activePaymentAttemptId: attemptId,
        })
        .where(eq(orders.id, purchase.id));
      yield* settlePassPurchase(purchase.id);
      const handler = yield* makeEntryPackOrderPaymentHandler;
      const interrupted = yield* Effect.result(
        handler.startRecovery({
          orderId: purchase.id,
          paymentAttemptId: attemptId,
          verifiedPaidAt: now,
        })
      );
      expect(interrupted).toMatchObject({
        failure: { _tag: "DotyposRejected", operation: "getReservationsByIds" },
      });
      const replacementDays = yield* readUnlimitedPassDays(purchase.id);
      expect(replacementDays).toHaveLength(unlimitedPassDays);
      expect(
        replacementDays.every(
          ({ reservationState }) => reservationState === "held"
        )
      ).toBe(true);

      yield* db
        .update(customerAccounts)
        .set({ deletedAt: now })
        .where(eq(customerAccounts.id, purchase.holderAccountId));
      const resumed = yield* Effect.result(
        handler.resumeRecovery({
          orderId: purchase.id,
          paymentAttemptId: attemptId,
        })
      );
      const rejected = yield* readState(purchase.id);
      expect(rejected.order?.paymentState).toBe("expired");
      expect(rejected.purchase?.status).toBe("void");
      expect(rejected.attempts[0]).toMatchObject({
        state: "paid",
        refundState: "required",
        refundTargetValue: price.value,
      });
      expect(resumed).toMatchObject({ success: true });

      yield* reconcileUnlimitedPassReleases({ now, limit: 2 });
      expect(
        (yield* readUnlimitedPassDays(purchase.id)).every(
          ({ reservationState }) => reservationState === "cancelled"
        )
      ).toBe(true);
    }).pipe(
      Effect.provide(servicesFor(withInterruptedHoldRead(provider.service)))
    )
  );
});

for (const tier of ["open-space", "reserved-desk"] as const) {
  it(`requires a full refund when the first ${tier} service day ends during recovery`, async () => {
    const start = getCurrentWorkspaceDate().add({ days: 190 });
    const endsAt = Temporal.Instant.from(
      getCoworkReservationInterval(tier, start.toString()).endsAt
    );
    const beforeClosing = endsAt.subtract({ minutes: 2 });
    const services = servicesFor({
      ...provider.service,
      getReservationsByIds: (ids, options) =>
        provider.service
          .getReservationsByIds(ids, options)
          .pipe(Effect.tap(() => TestClock.setTime(endsAt.epochMilliseconds))),
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(beforeClosing.epochMilliseconds);
        const { db } = yield* WorkspaceDatabase;
        const purchase = yield* recordPurchase(beforeClosing, 0, tier);
        const attemptId = yield* recordAttempt(
          purchase.id,
          "expired",
          beforeClosing
        );
        yield* createUnlimitedPassHolds(purchase);
        yield* db
          .update(orders)
          .set({
            paymentState: "expired",
            activePaymentAttemptId: attemptId,
          })
          .where(eq(orders.id, purchase.id));
        const handler = yield* makeEntryPackOrderPaymentHandler;
        yield* handler.startRecovery({
          orderId: purchase.id,
          paymentAttemptId: attemptId,
          verifiedPaidAt: beforeClosing,
        });
        const rejected = yield* readState(purchase.id);
        expect(rejected.order?.paymentState).toBe("expired");
        expect(rejected.purchase?.status).toBe("void");
        expect(rejected.attempts[0]).toMatchObject({
          state: "paid",
          refundState: "required",
          refundTargetValue: price.value,
        });
        yield* reconcileUnlimitedPassReleases({ now: endsAt, limit: 2 });
      }).pipe(Effect.provide(Layer.merge(services, TestClock.layer())))
    );
  });
}

it("rechecks the first service day before activation after provider confirmation", async () => {
  const start = getCurrentWorkspaceDate().add({ days: 265 });
  const endsAt = Temporal.Instant.from(
    getCoworkReservationInterval("open-space", start.toString()).endsAt
  );
  const beforeClosing = endsAt.subtract({ minutes: 2 });
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* WorkspaceDatabase;
      yield* TestClock.setTime(beforeClosing.epochMilliseconds);
      const purchase = yield* recordPurchase(beforeClosing, 0, "open-space");
      const paidId = yield* recordAttempt(purchase.id, "paid", beforeClosing);
      yield* createUnlimitedPassHolds(purchase);
      yield* db
        .update(orders)
        .set({
          paymentState: "paid",
          activePaymentAttemptId: paidId,
          paidAt: beforeClosing,
        })
        .where(eq(orders.id, purchase.id));
      yield* settlePassPurchase(purchase.id);
      yield* confirmUnlimitedPassDays(purchase);
      yield* TestClock.setTime(endsAt.epochMilliseconds);

      expect(yield* settlePassPurchase(purchase.id, paidId)).toBeUndefined();
      const rejected = yield* readState(purchase.id);
      expect(rejected.purchase?.status).toBe("void");
      expect(rejected.order?.fulfillmentState).toBe("failed");
      expect(rejected.attempts[0]).toMatchObject({
        refundState: "required",
        refundTargetValue: price.value,
      });
      yield* reconcileUnlimitedPassReleases({ now: endsAt, limit: 2 });
    }).pipe(
      Effect.provide(
        Layer.merge(servicesFor(provider.service), TestClock.layer())
      )
    )
  );
});

it("rechecks a refund recorded after provider confirmation before first activation", async () => {
  const now = Temporal.Now.instant();
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* WorkspaceDatabase;
      const purchase = yield* recordPurchase(now, 45);
      const paidId = yield* recordAttempt(purchase.id, "paid", now);
      yield* createUnlimitedPassHolds(purchase);
      yield* db
        .update(orders)
        .set({
          paymentState: "paid",
          activePaymentAttemptId: paidId,
          paidAt: now,
        })
        .where(eq(orders.id, purchase.id));
      yield* settlePassPurchase(purchase.id);
      expect(yield* canConfirmUnlimitedPass(purchase.id, paidId)).toBe(true);
      yield* confirmUnlimitedPassDays(purchase);
      yield* db
        .update(paymentAttempts)
        .set({
          refundState: "refunded",
          refundedAmountValue: price.value,
          refundedAt: now,
        })
        .where(eq(paymentAttempts.id, paidId));

      expect(yield* settlePassPurchase(purchase.id, paidId)).toBeUndefined();
      const ended = yield* readState(purchase.id);
      expect(ended.purchase?.status).toBe("void");
      expect(ended.order?.fulfillmentState).toBe("failed");
      yield* reconcileUnlimitedPassReleases({ now, limit: 2 });
      expect(
        (yield* readUnlimitedPassDays(purchase.id)).every(
          (day) =>
            day.dotyposReservationId !== null &&
            provider.reservations.get(day.dotyposReservationId)?.status ===
              "CANCELLED"
        )
      ).toBe(true);
    }).pipe(Effect.provide(servicesFor(provider.service)))
  );
});

it("rolls back failed expiry settlement and repairs an already split expiry on the next run", async () => {
  const now = Temporal.Now.instant();
  const old = now.subtract({ hours: 1 });
  const services = servicesFor(provider.service);
  const { first, split } = await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* WorkspaceDatabase;
      const first = yield* recordPurchase(old, 70);
      const split = yield* recordPurchase(old, 105);
      yield* db
        .update(orders)
        .set({ paymentState: "expired" })
        .where(eq(orders.id, split.id));
      return { first, split };
    }).pipe(Effect.provide(services))
  );
  await database!.pool.query(`
    create function reject_unlimited_expiry() returns trigger
    language plpgsql as $$
    begin
      if new.status = 'void' then
        raise exception 'fixture expiry settlement failure';
      end if;
      return new;
    end;
    $$;
    create trigger reject_unlimited_expiry before update on pass_purchases
    for each row execute function reject_unlimited_expiry();
  `);
  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      WorkspaceDatabase | DotyposService | WorkspaceDatabaseAdvisoryLock
    >
  ) => Effect.runPromise(effect.pipe(Effect.provide(services)));
  try {
    await run(reconcileUnlimitedPassReleases({ now, limit: 2 }));
    const unpaid = await run(readState(first.id));
    expect(unpaid.order?.paymentState).toBe("not_started");
    expect(unpaid.purchase?.status).toBe("pending_payment");
    const interrupted = await run(readState(split.id));
    expect(interrupted.order?.paymentState).toBe("expired");
    expect(interrupted.purchase?.status).toBe("pending_payment");
  } finally {
    await database!.pool.query(
      "drop trigger reject_unlimited_expiry on pass_purchases"
    );
  }
  expect(await run(reconcileUnlimitedPassReleases({ now, limit: 2 }))).toBe(2);
  for (const purchase of [first, split]) {
    expect((await run(readState(purchase.id))).purchase?.status).toBe("void");
    expect(
      (await run(readUnlimitedPassDays(purchase.id))).every(
        (day) =>
          day.paymentState === "expired" &&
          day.reservationState === "hold_expired"
      )
    ).toBe(true);
  }
});

it("reconciles only the service dates after access ends on a withdrawn pass", async () => {
  const now = Temporal.Now.instant();
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* WorkspaceDatabase;
      const purchase = yield* recordPurchase(now, 0);
      const paidId = yield* recordAttempt(purchase.id, "paid", now);
      yield* createUnlimitedPassHolds(purchase);
      yield* db
        .update(orders)
        .set({
          paymentState: "paid",
          activePaymentAttemptId: paidId,
          paidAt: now,
        })
        .where(eq(orders.id, purchase.id));
      yield* settlePassPurchase(purchase.id);
      yield* confirmUnlimitedPassDays(purchase);
      expect((yield* settlePassPurchase(purchase.id, paidId))?.status).toBe(
        "active"
      );
      yield* db
        .update(passPurchases)
        .set({
          status: "withdrawn",
          accessEndsOn: date(getCurrentWorkspaceDate(now).add({ days: 1 })),
        })
        .where(eq(passPurchases.id, purchase.id));
      yield* db
        .update(paymentAttempts)
        .set({ refundState: "required", refundTargetValue: 100_000 })
        .where(eq(paymentAttempts.id, paidId));

      expect(yield* reconcileUnlimitedPassReleases({ now, limit: 2 })).toBe(1);
      expect(yield* reconcileUnlimitedPassReleases({ now, limit: 2 })).toBe(0);
      const days = yield* readUnlimitedPassDays(purchase.id);
      expect(days[0]?.reservationState).toBe("confirmed");
      expect(
        days
          .slice(1)
          .every(({ reservationState }) => reservationState === "cancelled")
      ).toBe(true);
      expect((yield* readState(purchase.id)).purchase?.status).toBe(
        "withdrawn"
      );
    }).pipe(Effect.provide(servicesFor(provider.service)))
  );
});
