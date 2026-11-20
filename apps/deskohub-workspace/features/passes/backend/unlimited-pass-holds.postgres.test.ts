import "@/shared/testing/workspace-test-env";

import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  DotyposCustomerIdSchema,
  DotyposService,
  DotyposTableIdSchema,
  DotyposUncertain,
} from "@deskohub/dotypos";
import { makeInMemoryDotypos } from "@deskohub/dotypos/testing";
import { eq } from "drizzle-orm";
import { Effect, Result } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { customerAccounts, orders } from "@/db/schema";
import { customerAccountIdSchema } from "@/features/account/customer-account";
import { orderIdSchema } from "@/features/order";
import { getCurrentWorkspaceDate } from "@/features/reservation/reservation-date";
import { currencyCZK } from "@/shared/money/currencies";
import { fixtureReservationAuthorId } from "@/shared/testing/workspace-fixtures.test-utils";
import {
  createWorkspacePostgresSuiteDatabase,
  type WorkspacePostgresSuiteDatabase,
} from "@/shared/testing/workspace-postgres-test-database.test-utils";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import { unlimitedPassDays } from "../pass-offer";
import { settlePassPurchase } from "./entry-pack-settlement";
import {
  confirmUnlimitedPassDays,
  createUnlimitedPassHolds,
  readUnlimitedPassDays,
  reconfirmUnlimitedPassHolds,
  releaseUnlimitedPassDays,
} from "./unlimited-pass-holds";
import { recordUnlimitedPassOrder } from "./unlimited-pass-orders";

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
