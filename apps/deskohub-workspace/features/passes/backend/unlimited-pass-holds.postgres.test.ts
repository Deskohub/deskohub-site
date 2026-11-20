import "@/shared/testing/workspace-test-env";

import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  DotyposCustomerIdSchema,
  DotyposService,
  DotyposTableIdSchema,
  DotyposTableSchema,
  DotyposUncertain,
} from "@deskohub/dotypos";
import { makeInMemoryDotypos } from "@deskohub/dotypos/testing";
import { EmailDeliveryIdSchema } from "@deskohub/email";
import { eq } from "drizzle-orm";
import { Effect, Layer, Result, Schema } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { WorkspaceDatabaseAdvisoryLock } from "@/db/postgres-advisory-lock";
import {
  customerAccounts,
  orders,
  passPurchases,
  paymentAttempts,
} from "@/db/schema";
import { WorkspaceLockSections } from "@/db/workspace-locks";
import { customerAccountIdSchema } from "@/features/account/customer-account";
import { paymentAttemptIdSchema } from "@/features/checkout/checkout-identifiers";
import { orderIdSchema } from "@/features/order";
import { GoogleCalendarWorkspaceLimitationsService } from "@/features/reservation/backend/google-calendar-workspace-limitations.service";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import { getCurrentWorkspaceDate } from "@/features/reservation/reservation-date";
import {
  deliveryReportEmailId,
  deliveryReportEventId,
} from "@/shared/backend/email/delivery-reports";
import { currencyCZK } from "@/shared/money/currencies";
import { fixtureReservationAuthorId } from "@/shared/testing/workspace-fixtures.test-utils";
import {
  createWorkspacePostgresSuiteDatabase,
  type WorkspacePostgresSuiteDatabase,
} from "@/shared/testing/workspace-postgres-test-database.test-utils";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import { unlimitedPassDays } from "../pass-offer";
import { settlePassPurchase } from "./entry-pack-settlement";
import { unlimitedConfirmationDeliveryReports } from "./unlimited-confirmation-delivery";
import {
  confirmUnlimitedPassDays,
  createUnlimitedPassHolds,
  readUnlimitedPassDays,
  reconfirmUnlimitedPassHolds,
  releaseUnlimitedPassDays,
} from "./unlimited-pass-holds";
import { recordUnlimitedPassOrder } from "./unlimited-pass-orders";
import { prepareUnlimitedPassRecovery } from "./unlimited-pass-recovery";

let database: WorkspacePostgresSuiteDatabase | null;
beforeAll(async () => {
  database = await createWorkspacePostgresSuiteDatabase("unlimited_holds");
});
afterAll(async () => {
  await database?.close();
});

const it = test.skipIf(!process.env.WORKSPACE_TEST_DATABASE_URL);
const customerId = DotyposCustomerIdSchema.make("123");
const tableId = DotyposTableIdSchema.make("42");
const date = (value: Temporal.PlainDate) =>
  plainDateStringSchema.make(value.toString());
const newAccountId = () => customerAccountIdSchema.make(crypto.randomUUID());

const record = (start: Temporal.PlainDate, buyer = newAccountId()) =>
  Effect.gen(function* () {
    const { db, transaction } = yield* WorkspaceDatabase;
    yield* db.insert(customerAccounts).values({ id: buyer });
    return yield* transaction(
      recordUnlimitedPassOrder({
        orderId: orderIdSchema.make(crypto.randomUUID()),
        locale: "en-US",
        buyer: { accountId: buyer, customerId },
        holder: { accountId: fixtureReservationAuthorId, customerId },
        createdAt: Temporal.Now.instant(),
        selection: { startDate: date(start), tier: "reserved-desk" },
        quote: {
          product: { kind: "unlimited", tier: "reserved-desk" },
          discountableSubtotal: currencyCZK(599_000),
          discountedSubtotal: currencyCZK(599_000),
          totalDiscount: currencyCZK(0),
          discounts: [],
        },
        days: Array.from({ length: unlimitedPassDays }, (_, index) => ({
          serviceDate: date(start.add({ days: index })),
          tableId,
        })),
      })
    );
  });

it("serializes overlapping entitlement purchases for the same holder", async () => {
  const start = getCurrentWorkspaceDate().add({ days: 60 });
  const results = await Effect.runPromise(
    Effect.all(
      [
        Effect.result(record(start)),
        Effect.result(record(start.add({ days: 1 }))),
      ],
      { concurrency: 2 }
    ).pipe(Effect.provide(database!.layer))
  );
  expect(results.filter(Result.isSuccess)).toHaveLength(1);
  expect(
    results.filter(Result.isFailure).map((result) => result.failure)
  ).toEqual([expect.objectContaining({ reason: "overlapping-pass" })]);
});

it("records the earliest verified buyer delivery for the winning attempt only", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const purchase = yield* record(
        getCurrentWorkspaceDate().add({ days: 100 })
      );
      const { db } = yield* WorkspaceDatabase;
      const attemptId = paymentAttemptIdSchema.make(crypto.randomUUID());
      const paidAt = Temporal.Instant.from("2026-11-20T10:00:00Z");
      yield* db.insert(paymentAttempts).values({
        id: attemptId,
        orderId: purchase.id,
        provider: "internal",
        state: "paid",
        amountValue: 0,
        amountExponent: 2,
        currency: "CZK",
      });
      yield* db
        .update(orders)
        .set({
          paymentState: "paid",
          paidAt,
          activePaymentAttemptId: attemptId,
        })
        .where(eq(orders.id, purchase.id));

      const report = (
        minutes: number,
        paymentId: string,
        deployment = "preview"
      ) =>
        unlimitedConfirmationDeliveryReports.receive({
          eventId: deliveryReportEventId(`fixture-delivery-${minutes}`),
          event: "email.delivered",
          emailId: deliveryReportEmailId(
            EmailDeliveryIdSchema.make("fixture-email")
          ),
          occurredAt: paidAt.add({ minutes }),
          tags: new Map([
            ["orderId", purchase.id],
            ["paymentAttemptId", paymentId],
            ["deploymentEnvironment", deployment],
          ]),
          deploymentEnvironment: "preview",
        });
      expect((yield* report(1, "obsolete-attempt")).status).toBe("ignored");
      expect((yield* report(2, attemptId, "production")).status).toBe(
        "ignored"
      );
      expect((yield* report(8, attemptId)).status).toBe("processed");
      expect((yield* report(4, attemptId)).status).toBe("processed");
      expect((yield* report(10, attemptId)).status).toBe("processed");
      const [recorded] = yield* db
        .select({ deliveredAt: passPurchases.buyerConfirmationDeliveredAt })
        .from(passPurchases)
        .where(eq(passPurchases.id, purchase.id));
      expect(recorded?.deliveredAt?.equals(paidAt.add({ minutes: 4 }))).toBe(
        true
      );
    }).pipe(Effect.provide(database!.layer))
  );
});

it("reacquires all provider holds on the original rows after terminal payment", async () => {
  const testDatabase = (await createWorkspacePostgresSuiteDatabase(
    "unlimited_recovery"
  ))!;
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
  const services = Layer.mergeAll(
    testDatabase.layer,
    provider.layer,
    WorkspaceDatabaseAdvisoryLock.makeLayer(testDatabase.databasePool),
    WorkspaceReservationRepository.Default.pipe(
      Layer.provide(testDatabase.layer)
    ),
    Layer.mock(GoogleCalendarWorkspaceLimitationsService, {
      listLimitations: () => Effect.succeed([]),
    })
  );

  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const purchase = yield* record(
          getCurrentWorkspaceDate().add({ days: 140 })
        );
        yield* createUnlimitedPassHolds(purchase);
        const initial = yield* readUnlimitedPassDays(purchase.id);
        const { db } = yield* WorkspaceDatabase;
        const attemptId = paymentAttemptIdSchema.make(crypto.randomUUID());
        yield* db.insert(paymentAttempts).values({
          id: attemptId,
          orderId: purchase.id,
          provider: "mock",
          providerOrderId: "fixture-unlimited-payment",
          state: "expired",
          failureCode: "fixture_expired",
          amountValue: 599_000,
          amountExponent: 2,
          currency: "CZK",
        });
        yield* db
          .update(orders)
          .set({ paymentState: "expired", activePaymentAttemptId: attemptId })
          .where(eq(orders.id, purchase.id));
        yield* settlePassPurchase(purchase.id);

        const restored = yield* prepareUnlimitedPassRecovery(
          purchase.id,
          attemptId
        ).pipe(WorkspaceLockSections.unlimitedPassRecovery(purchase.id));
        expect(restored).toBe(true);
        const replaced = yield* readUnlimitedPassDays(purchase.id);
        expect(replaced.map(({ id }) => id)).toEqual(
          initial.map(({ id }) => id)
        );
        expect(
          replaced.every(
            (row, index) =>
              row.dotyposReservationId !== initial[index]?.dotyposReservationId
          )
        ).toBe(true);
        const providerRecords = [...provider.reservations.values()];
        expect(
          providerRecords.filter((record) => record.status === "NEW")
        ).toHaveLength(unlimitedPassDays);
        expect(
          providerRecords.filter((record) => record.status === "CANCELLED")
        ).toHaveLength(unlimitedPassDays);
      }).pipe(Effect.provide(services))
    );
  } finally {
    await testDatabase.close();
  }
});

it("adopts an ambiguous POST, reconfirms all days, then retains today on release", async () => {
  const provider = makeInMemoryDotypos({});
  let interruptOnce = true;
  const createReservation: typeof provider.service.createReservation = (
    input
  ) =>
    provider.service.createReservation(input).pipe(
      Effect.flatMap((created) => {
        if (!interruptOnce) return Effect.succeed(created);
        interruptOnce = false;
        return Effect.fail(
          new DotyposUncertain({
            operation: "createReservation",
            reason: "timeout",
          })
        );
      })
    );

  await Effect.runPromise(
    Effect.gen(function* () {
      const start = getCurrentWorkspaceDate().add({ days: 1 });
      const purchase = yield* record(start);
      const initial = yield* readUnlimitedPassDays(purchase.id);
      const attempt = yield* Effect.result(createUnlimitedPassHolds(purchase));
      expect(Result.isFailure(attempt)).toBe(true);
      expect(provider.reservations.size).toBeGreaterThan(0);
      const incomplete = yield* Effect.result(
        reconfirmUnlimitedPassHolds(purchase)
      );
      expect(Result.isFailure(incomplete)).toBe(true);

      yield* createUnlimitedPassHolds(purchase);
      yield* reconfirmUnlimitedPassHolds(purchase);
      expect(provider.reservations.size).toBe(unlimitedPassDays);
      expect(
        (yield* readUnlimitedPassDays(purchase.id)).map(({ id }) => id)
      ).toEqual(initial.map(({ id }) => id));

      const now = Temporal.Now.instant();
      const { db } = yield* WorkspaceDatabase;
      yield* db
        .update(orders)
        .set({ paymentState: "paid", paidAt: now, updatedAt: now })
        .where(eq(orders.id, purchase.id));
      expect(yield* settlePassPurchase(purchase.id)).toBeUndefined();
      yield* confirmUnlimitedPassDays(purchase);
      yield* confirmUnlimitedPassDays(purchase);
      expect(
        (yield* settlePassPurchase(purchase.id, "completed"))?.status
      ).toBe("active");
      expect(
        [...provider.reservations.values()].every(
          (row) => row.status === "CONFIRMED"
        )
      ).toBe(true);

      yield* releaseUnlimitedPassDays({
        ...purchase,
        status: "withdrawn",
        accessEndsOn: date(start.add({ days: 1 })),
      });
      const days = yield* readUnlimitedPassDays(purchase.id);
      expect(days[0]?.reservationState).toBe("confirmed");
      expect(
        days.slice(1).every((row) => row.reservationState === "cancelled")
      ).toBe(true);
    }).pipe(
      Effect.provide(database!.layer),
      Effect.provideService(DotyposService, {
        ...provider.service,
        createReservation,
      })
    )
  );
});
