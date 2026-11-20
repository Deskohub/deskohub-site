import "server-only";

import {
  and,
  asc,
  eq,
  exists,
  inArray,
  isNull,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { Effect, Layer } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { WorkspaceDatabaseAdvisoryLock } from "@/db/postgres-advisory-lock";
import {
  entryPackGiftInvitations,
  orders,
  passPurchases,
  paymentAttempts,
  workspaceReservations,
} from "@/db/schema";
import { WorkspaceLockSections } from "@/db/workspace-locks";
import { OrderPaymentHandlers } from "@/features/checkout/backend/payment/order-payment-handlers.service";
import { PaymentProviders } from "@/features/checkout/backend/payment/payment-provider";
import { PaymentProvidersLive } from "@/features/checkout/backend/payment/payment-providers";
import { ProviderPaymentFinalizationService } from "@/features/checkout/backend/payment/provider-payment-finalization.service";
import { providerOrderAbandonmentTimeoutMinutes } from "@/features/checkout/provider-order-abandonment";
import { WorkspaceDotyposLayer } from "@/shared/backend/config/dotypos.config";
import { entryPackGiftInvitationDue } from "./entry-pack-gift";
import { settlePassPurchase } from "./entry-pack-settlement";
import { releaseUnlimitedPassDays } from "./unlimited-pass-holds";

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
          .leftJoin(
            entryPackGiftInvitations,
            eq(entryPackGiftInvitations.orderId, orders.id)
          )
          .where(
            and(
              eq(orders.kind, "pass-purchase"),
              eq(orders.paymentState, "paid"),
              or(
                inArray(orders.fulfillmentState, [
                  "not_started",
                  "awaiting_delivery",
                ]),
                entryPackGiftInvitationDue(input.now)
              ),
              lte(orders.updatedAt, retryBefore)
            )
          )
          .orderBy(asc(orders.updatedAt), asc(orders.id))
          .limit(input.limit)
          .for("no key update", { of: orders, skipLocked: true });
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
        Effect.catch(() =>
          Effect.logWarning("Pass fulfillment retry failed", {
            orderId,
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

export const runPassPurchaseReconciliation = Effect.fn(
  "runPassPurchaseReconciliation"
)(
  function* (input: {
    readonly now: Temporal.Instant;
    readonly limit: number;
  }) {
    const summary = yield* reconcilePassPurchases(input);
    const releasesChecked = yield* reconcileUnlimitedPassReleases(input);
    return { ...summary, releasesChecked };
  },
  Effect.provide(
    Layer.mergeAll(
      WorkspaceDatabase.Default,
      WorkspaceDatabaseAdvisoryLock.Default,
      WorkspaceDotyposLayer,
      OrderPaymentHandlers.Live,
      PaymentProvidersLive,
      ProviderPaymentFinalizationService.Live
    )
  )
);

const reconcileUnlimitedPassReleases = Effect.fn(
  "reconcileUnlimitedPassReleases"
)(function* (input: {
  readonly now: Temporal.Instant;
  readonly limit: number;
}) {
  const { db } = yield* WorkspaceDatabase;
  const due = (now: Temporal.Instant) =>
    or(
      eq(passPurchases.status, "void"),
      and(
        inArray(passPurchases.status, ["withdrawn", "cancelled"]),
        sql`${passPurchases.accessEndsOn} is not null`
      ),
      and(
        eq(passPurchases.status, "pending_payment"),
        eq(orders.paymentState, "not_started"),
        lte(passPurchases.holdsExpireAt, now)
      )
    );
  const batch = yield* db
    .select({ id: passPurchases.id })
    .from(passPurchases)
    .innerJoin(orders, eq(orders.id, passPurchases.id))
    .where(
      and(
        eq(passPurchases.product, "unlimited"),
        due(input.now),
        exists(
          db
            .select({ id: workspaceReservations.id })
            .from(workspaceReservations)
            .where(
              and(
                eq(workspaceReservations.passId, passPurchases.id),
                notInArray(workspaceReservations.reservationState, [
                  "cancelled",
                  "hold_expired",
                ]),
                sql`(${passPurchases.accessEndsOn} is null or ${workspaceReservations.serviceDate} >= ${passPurchases.accessEndsOn})`
              )
            )
        )
      )
    )
    .orderBy(asc(orders.updatedAt), asc(orders.id))
    .limit(Math.min(input.limit, 2));

  for (const { id } of batch) {
    yield* Effect.gen(function* () {
      const [entry] = yield* db
        .select({ order: orders, purchase: passPurchases })
        .from(passPurchases)
        .innerJoin(orders, eq(orders.id, passPurchases.id))
        .where(and(eq(passPurchases.id, id), due(input.now)));
      if (!entry) return;
      if (entry.purchase.status === "pending_payment") {
        const [expired] = yield* db
          .update(orders)
          .set({ paymentState: "expired", updatedAt: input.now })
          .where(and(eq(orders.id, id), eq(orders.paymentState, "not_started")))
          .returning({ id: orders.id });
        if (!expired) return;
        yield* settlePassPurchase(id);
      } else {
        yield* db
          .update(orders)
          .set({ updatedAt: input.now })
          .where(eq(orders.id, id));
      }
      yield* releaseUnlimitedPassDays(entry.purchase);
    }).pipe(
      WorkspaceLockSections.passPurchaseFulfillment(id),
      WorkspaceLockSections.unlimitedPassRecovery(id),
      Effect.timeout("90 seconds"),
      Effect.catch(() =>
        Effect.logWarning("Unlimited pass release needs reconciliation", {
          orderId: id,
        })
      )
    );
  }
  return batch.length;
});
