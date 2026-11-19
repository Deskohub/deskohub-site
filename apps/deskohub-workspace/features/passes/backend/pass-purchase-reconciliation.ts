import "server-only";

import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { orders, paymentAttempts } from "@/db/schema";
import { OrderPaymentHandlers } from "@/features/checkout/backend/payment/order-payment-handlers.service";
import { PaymentProviders } from "@/features/checkout/backend/payment/payment-provider";
import { PaymentProvidersLive } from "@/features/checkout/backend/payment/payment-providers";
import { ProviderPaymentFinalizationService } from "@/features/checkout/backend/payment/provider-payment-finalization.service";
import { providerOrderAbandonmentTimeoutMinutes } from "@/features/checkout/provider-order-abandonment";

/** Retries paid fulfillment and resolves abandoned attempts from provider facts. */
export const reconcilePassPurchases = Effect.fn("reconcilePassPurchases")(
  function* (input: {
    readonly now: Temporal.Instant;
    readonly limit: number;
  }) {
    const { db, transaction } = yield* WorkspaceDatabase;
    const finalization = yield* ProviderPaymentFinalizationService;
    const providers = yield* PaymentProviders;
    const registry = yield* OrderPaymentHandlers;
    const handler = registry.byKind["pass-purchase"];
    if (!handler) return { paymentsChecked: 0, fulfillmentRetried: 0 };

    const retryBefore = input.now.subtract({ minutes: 5 });
    const providerCreatedBefore = input.now.subtract({
      minutes: providerOrderAbandonmentTimeoutMinutes,
    });
    // Move each claimed row to the back before calling providers. This also
    // gives an interrupted or inconclusive run a finite retry delay.
    const { expired, unfulfilled } = yield* transaction(
      Effect.gen(function* () {
        const expired = yield* db
          .select({
            orderId: orders.id,
            paymentAttemptId: paymentAttempts.id,
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
              inArray(paymentAttempts.provider, providers.activeProviders),
              inArray(paymentAttempts.state, ["created", "pending"]),
              lte(orders.updatedAt, retryBefore),
              or(
                lte(
                  paymentAttempts.providerOrderCreatedAt,
                  providerCreatedBefore
                ),
                and(
                  isNull(paymentAttempts.providerOrderCreatedAt),
                  lte(paymentAttempts.createdAt, providerCreatedBefore)
                )
              )
            )
          )
          .orderBy(asc(orders.updatedAt), asc(orders.id))
          .limit(input.limit)
          .for("no key update", { of: orders, skipLocked: true });
        const unfulfilled = yield* db
          .select({ orderId: orders.id })
          .from(orders)
          .where(
            and(
              eq(orders.kind, "pass-purchase"),
              eq(orders.paymentState, "paid"),
              inArray(orders.fulfillmentState, [
                "not_started",
                "awaiting_delivery",
              ]),
              lte(orders.updatedAt, retryBefore)
            )
          )
          .orderBy(asc(orders.updatedAt), asc(orders.id))
          .limit(input.limit)
          .for("no key update", { skipLocked: true });
        const claimed = [...expired, ...unfulfilled].map(
          ({ orderId }) => orderId
        );
        if (claimed.length > 0) {
          yield* db
            .update(orders)
            .set({ updatedAt: input.now })
            .where(inArray(orders.id, claimed));
        }
        return { expired, unfulfilled };
      })
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
        PaymentProvidersLive,
        ProviderPaymentFinalizationService.Live
      )
    )
  );
