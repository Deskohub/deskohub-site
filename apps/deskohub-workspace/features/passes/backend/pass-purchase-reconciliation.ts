import "server-only";

import { and, asc, eq, inArray, lte } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { orders, paymentAttempts } from "@/db/schema";
import { OrderPaymentHandlers } from "@/features/checkout/backend/payment/order-payment-handlers.service";
import { ProviderPaymentFinalizationService } from "@/features/checkout/backend/payment/provider-payment-finalization.service";
import { getPaymentAttemptAbandonmentCutoff } from "@/features/checkout/provider-order-abandonment";

/** Retries paid fulfillment and resolves abandoned attempts from provider facts. */
export const reconcilePassPurchases = Effect.fn("reconcilePassPurchases")(
  function* (input: {
    readonly now: Temporal.Instant;
    readonly limit: number;
  }) {
    const { db } = yield* WorkspaceDatabase;
    const finalization = yield* ProviderPaymentFinalizationService;
    const registry = yield* OrderPaymentHandlers;
    const handler = registry.byKind["pass-purchase"];
    if (!handler) return { paymentsChecked: 0, fulfillmentRetried: 0 };

    const pending = yield* db
      .select({
        orderId: orders.id,
        paymentAttemptId: paymentAttempts.id,
        createdAt: paymentAttempts.createdAt,
        providerOrderCreatedAt: paymentAttempts.providerOrderCreatedAt,
      })
      .from(orders)
      .innerJoin(
        paymentAttempts,
        and(
          eq(paymentAttempts.id, orders.activePaymentAttemptId),
          eq(paymentAttempts.orderId, orders.id)
        )
      )
      .where(
        and(
          eq(orders.kind, "pass-purchase"),
          eq(orders.paymentState, "pending"),
          eq(paymentAttempts.provider, "nexi"),
          inArray(paymentAttempts.state, ["created", "pending"])
        )
      )
      .orderBy(asc(paymentAttempts.createdAt), asc(orders.id))
      .limit(input.limit);
    const unfulfilled = yield* db
      .select({ orderId: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.kind, "pass-purchase"),
          eq(orders.paymentState, "paid"),
          eq(orders.fulfillmentState, "not_started"),
          lte(orders.updatedAt, input.now.subtract({ minutes: 5 }))
        )
      )
      .orderBy(asc(orders.updatedAt), asc(orders.id))
      .limit(input.limit);

    const expired = pending.filter(
      (attempt) =>
        Temporal.Instant.compare(
          input.now,
          getPaymentAttemptAbandonmentCutoff(attempt)
        ) >= 0
    );
    for (const { orderId, paymentAttemptId } of expired) {
      yield* Effect.gen(function* () {
        const result = yield* finalization.finalizePendingProviderPayment({
          orderId,
          paymentAttemptId,
          abandonmentCheckedAt: input.now,
          verificationDeadline: "8 seconds",
        });
        if (result === "abandoned") {
          yield* handler.markTerminal({
            orderId,
            id: paymentAttemptId,
            state: "expired",
            failureCode: "payment_abandoned_after_provider_cutoff",
            fromAttemptStates: ["pending"],
          });
        }
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Pass payment reconciliation failed", {
            orderId,
            cause,
          })
        )
      );
    }
    for (const { orderId } of unfulfilled) {
      yield* handler.fulfill(orderId).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Pass fulfillment retry failed", {
            orderId,
            cause,
          })
        )
      );
    }
    return {
      paymentsChecked: expired.length,
      fulfillmentRetried: unfulfilled.length,
    };
  }
);

export const runPassPurchaseReconciliation = (input: {
  readonly now: Temporal.Instant;
  readonly limit: number;
}) =>
  reconcilePassPurchases(input).pipe(
    Effect.provide(
      Layer.mergeAll(
        WorkspaceDatabase.Default,
        OrderPaymentHandlers.Live,
        ProviderPaymentFinalizationService.Live
      )
    )
  );
