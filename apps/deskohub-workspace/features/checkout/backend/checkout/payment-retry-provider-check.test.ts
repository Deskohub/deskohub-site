import { PaymentProvidersFromNexi } from "../payment/payment-providers";
import "@/shared/testing/workspace-test-env";

import { describe, expect, test } from "bun:test";
import { ExternalAPIError, type NexiOrder, NexiService } from "@deskohub/nexi";
import { Effect, Layer } from "effect";
import { NEXI_FALLBACK_ELIGIBLE_FAILURE_CODE } from "@/features/checkout/payment-fallback";
import { PaymentRetryProviderCheck } from "./payment-retry-provider-check";
import { PaymentRetryUnavailableError } from "./payment-retry-unavailable";

type RetryAttempt = Parameters<
  typeof PaymentRetryProviderCheck.Service.check
>[0]["attempt"];
const amount = { value: 29_000, exponent: 2, currency: "CZK" };

const check = (
  order: Partial<NexiOrder> | Error,
  attempt: RetryAttempt = {
    provider: "nexi",
    providerOrderId: "provider-order-id" as never,
    failureCode: null,
    amount,
  }
) =>
  PaymentRetryProviderCheck.pipe(
    Effect.flatMap((providerCheck) =>
      providerCheck.check({
        attempt,
        reservation: { correlationId: "correlation-id" as never },
      })
    ),
    Effect.provide(
      PaymentRetryProviderCheck.Default.pipe(
        Layer.provide(
          PaymentProvidersFromNexi.pipe(
            Layer.provide(
              Layer.mock(NexiService, {
                getOrder: () =>
                  order instanceof Error
                    ? Effect.fail(order as never)
                    : Effect.succeed({
                        orderId: "provider-order-id",
                        operations: [],
                        ...order,
                      } as NexiOrder),
              })
            )
          )
        )
      )
    ),
    Effect.result,
    Effect.runPromise
  );

const fallbackAttempt = {
  provider: "nexi",
  providerOrderId: "provider-order-id",
  failureCode: NEXI_FALLBACK_ELIGIBLE_FAILURE_CODE,
  amount,
} satisfies RetryAttempt;
const reportedAmount = {
  amount: String(amount.value),
  currency: "EUR", // The test environment uses the sandbox currency override.
};

describe("PaymentRetryProviderCheck", () => {
  test.each([
    ["no operation", []],
    [
      "a failed 3-D Secure authorization",
      [{ operationType: "AUTHORIZATION", operationResult: "THREEDS_FAILED" }],
    ],
    [
      "an abandoned authorization",
      [{ operationType: "AUTHORIZATION", operationResult: "CANCELED" }],
    ],
  ])("lets a payment with %s be retried", async (_name, operations) => {
    expect(await check({ operations })).toMatchObject({
      success: "ended_unpaid",
    });
  });

  test.each([
    [
      "an executed authorization",
      {
        operations: [
          { operationType: "AUTHORIZATION", operationResult: "EXECUTED" },
        ],
      },
    ],
    [
      "a pending operation",
      {
        operations: [{ operationType: "CAPTURE", operationResult: "PENDING" }],
      },
    ],
    [
      "a voided authorization",
      { operations: [{ operationType: "VOID", operationResult: "EXECUTED" }] },
    ],
    [
      "an operation of unknown type",
      {
        operations: [
          { operationType: "CARD_VERIFICATION", operationResult: "DECLINED" },
        ],
      },
    ],
    ["an authorized amount", { authorizedAmount: "29000" }],
    ["a captured amount", { capturedAmount: "29000" }],
  ])("refuses while the provider shows %s", async (_name, order) => {
    expect(await check(order)).toMatchObject({ success: "may_settle" });
  });

  test("reports an attempt without a provider order", async () => {
    expect(
      await check({}, { ...fallbackAttempt, providerOrderId: null })
    ).toMatchObject({
      success: "no_provider_order",
    });
  });

  test("fails as unavailable when the provider can't be asked", async () => {
    expect(await check(new Error("network"))).toMatchObject({
      failure: expect.any(PaymentRetryUnavailableError),
    });
  });

  test("allows a marked attempt only when Nexi reports no payment activity", async () => {
    expect(await check(reportedAmount, fallbackAttempt)).toMatchObject({
      success: "ended_unpaid",
    });
  });

  test.each([
    [
      "declined authorization",
      {
        operations: [
          { operationType: "AUTHORIZATION", operationResult: "THREEDS_FAILED" },
        ],
      },
    ],
    [
      "abandoned capture",
      {
        operations: [{ operationType: "CAPTURE", operationResult: "CANCELED" }],
      },
    ],
    [
      "pending capture",
      {
        operations: [{ operationType: "CAPTURE", operationResult: "PENDING" }],
      },
    ],
    ["operation summary", { lastOperationType: "AUTHORIZATION" }],
    [
      "operation time without details",
      { lastOperationTime: "2026-01-01T00:00:00Z" },
    ],
    ["authorized amount", { authorizedAmount: "1" }],
    ["malformed captured amount", { capturedAmount: "unknown" }],
    ["different order ID", { orderId: "other-order" as NexiOrder["orderId"] }],
    ["different order amount", { amount: "1" }],
    ["different order currency", { currency: "USD" }],
  ] satisfies Array<[string, Partial<NexiOrder>]>)(
    "blocks the marked retry when Nexi reports %s",
    async (_description, order) => {
      expect(
        await check({ ...reportedAmount, ...order }, fallbackAttempt)
      ).toMatchObject({
        success: "may_settle",
      });
    }
  );

  test("blocks the marked retry on a response without order details", async () => {
    expect(await check({}, fallbackAttempt)).toMatchObject({
      success: "may_settle",
    });
  });

  test.each([
    new Error("network"),
    new ExternalAPIError({
      service: "Nexi",
      operation: "getOrder",
      statusCode: 404,
    }),
  ])("blocks the marked retry on a failed lookup", async (error) => {
    expect(await check(error, fallbackAttempt)).toMatchObject({
      failure: expect.any(PaymentRetryUnavailableError),
    });
  });
});
