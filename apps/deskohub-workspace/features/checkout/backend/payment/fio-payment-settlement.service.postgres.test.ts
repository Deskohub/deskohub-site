import { afterAll, describe, expect, test } from "bun:test";
import { Effect, Layer, Redacted } from "effect";
import { createWorkspacePostgresSuiteDatabase } from "@/shared/testing/workspace-postgres-test-database.test-utils";
import { FioAccounts } from "../fio/fio-accounts.service";
import { PaidFulfillmentQueueService } from "../fulfillment/paid-fulfillment-queue.service";
import { FioPaymentSettlementRepository } from "../repositories/fio-payment-settlement.repository";
import { PaymentLifecycleRepository } from "../repositories/payment-lifecycle.repository";
import { QrPaymentRepository } from "../repositories/qr-payment.repository";
import {
  FioPaymentSettlementService,
  type VerifiedFioMovement,
} from "./fio-payment-settlement.service";
import { LatePaymentRecoveryQueueService } from "./late-payment-recovery-queue.service";

const database = await createWorkspacePostgresSuiteDatabase("fio_settlement");
afterAll(() => database?.close());

const accountKey = "settlement-test-account";
const movement = {
  accountKey,
  movementId: "foreign-credit",
  variableSymbol: null,
  referenceStatus: "invalid",
  amount: { _tag: "OtherCurrency", currency: "EUR", decimalAmount: "100.2500" },
  bookingDate: Temporal.PlainDate.from("2026-11-18"),
  observedAt: Temporal.Instant.from("2026-11-19T09:00:00Z"),
} satisfies VerifiedFioMovement;

const runSettlement = <A, E>(
  effect: Effect.Effect<A, E, FioPaymentSettlementService>
) => {
  const databaseLayer = database!.layer;
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(
        FioPaymentSettlementService.Default.pipe(
          Layer.provide(
            Layer.mergeAll(
              databaseLayer,
              FioPaymentSettlementRepository.Default.pipe(
                Layer.provide(databaseLayer)
              ),
              Layer.mock(FioAccounts, {
                getReceivingAccount: (key) =>
                  key === accountKey
                    ? {
                        accountKey,
                        account: {
                          accountNumber: "1234567890",
                          bankCode: "2010",
                        },
                        readToken: Redacted.make("synthetic-fio-token"),
                      }
                    : undefined,
              }),
              Layer.mock(QrPaymentRepository, {}),
              Layer.mock(PaymentLifecycleRepository, {}),
              Layer.mock(PaidFulfillmentQueueService, {}),
              Layer.mock(LatePaymentRecoveryQueueService, {})
            )
          )
        )
      )
    )
  );
};

describe.skipIf(!database)("verified Fio movement ingress", () => {
  test("retains the original decimal and records an invalid reference at account scope", async () => {
    const rows = await runSettlement(
      Effect.gen(function* () {
        const settlements = yield* FioPaymentSettlementService;
        yield* settlements.recordMovement(movement);
        return yield* settlements.listForAccount({ accountKey });
      })
    );

    expect(rows).toMatchObject([
      {
        movementId: "foreign-credit",
        orderId: null,
        paymentAttemptId: null,
        variableSymbol: null,
        currency: "EUR",
        amountValue: null,
        decimalAmount: "100.2500",
        bookingDate: "2026-11-18",
        disposition: "discrepancy",
        discrepancyReason: "reference_invalid",
      },
    ]);
  });

  test("ignores movements from an unconfigured receiving account", async () => {
    const unconfiguredAccount = "other-settlement-test-account";
    const rows = await runSettlement(
      Effect.gen(function* () {
        const settlements = yield* FioPaymentSettlementService;
        yield* settlements.recordMovement({
          ...movement,
          accountKey: unconfiguredAccount,
        });
        return yield* settlements.listForAccount({
          accountKey: unconfiguredAccount,
        });
      })
    );

    expect(rows).toEqual([]);
  });

  test("keeps a single immutable evidence row when an overlapping poll repeats a movement", async () => {
    const replayed = { ...movement, movementId: "overlapping-credit" };
    const rows = await runSettlement(
      Effect.gen(function* () {
        const settlements = yield* FioPaymentSettlementService;
        yield* Effect.all(
          [
            settlements.recordMovement(replayed),
            settlements.recordMovement(replayed),
          ],
          { concurrency: 2 }
        );
        yield* settlements.recordMovement({
          ...replayed,
          amount: { _tag: "CZK", minorUnits: 75 },
          observedAt: movement.observedAt.add({ hours: 4 }),
        });
        const evidence = yield* settlements.listForAccount({ accountKey });
        return evidence.filter((row) => row.movementId === replayed.movementId);
      })
    );

    expect(rows).toMatchObject([
      {
        currency: "EUR",
        decimalAmount: "100.2500",
        observedAt: movement.observedAt,
      },
    ]);
  });
});
