import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";
import { WorkspaceDatabase, WorkspaceTransaction } from "@/db/database.service";
import {
  orders,
  passPurchases,
  paymentAttempts,
  workspaceReservations,
} from "@/db/schema";
import type { PaymentAttemptId } from "@/features/checkout/checkout-identifiers";
import { isEndedUnpaidPaymentState, type OrderId } from "@/features/order";
import { currentInstant } from "@/shared/utils/temporal";
import { queueInitialEntryPackGift } from "./entry-pack-gift";

export const isUnsolicitedPartialPassRefund = (
  attempt: typeof paymentAttempts.$inferSelect
) =>
  attempt.refundState === "refunded" &&
  attempt.refundTargetValue === null &&
  attempt.refundedAmountValue !== null &&
  attempt.refundedAmountValue < attempt.amountValue;

/** The caller holds the payment attempt row lock. */
export const requireFullPassRefund = Effect.fn("requireFullPassRefund")(
  function* (
    attempt: typeof paymentAttempts.$inferSelect,
    now: Temporal.Instant
  ) {
    if (
      attempt.provider === "internal" ||
      (attempt.refundedAmountValue ?? 0) >= attempt.amountValue ||
      (attempt.refundState === "required" &&
        attempt.refundTargetValue === attempt.amountValue)
    )
      return;
    const { db } = yield* WorkspaceTransaction;
    yield* db
      .update(paymentAttempts)
      .set({
        refundState: "required",
        refundTargetValue: attempt.amountValue,
        updatedAt: now,
      })
      .where(eq(paymentAttempts.id, attempt.id));
  }
);

const checkUnlimitedActivation = Effect.fn("checkUnlimitedActivation")(
  function* (
    order: typeof orders.$inferSelect,
    attemptId: PaymentAttemptId,
    unavailable = false
  ) {
    if (
      order.paymentState !== "paid" ||
      order.activePaymentAttemptId !== attemptId
    )
      return false;
    const { db } = yield* WorkspaceTransaction;
    const [attempt] = yield* db
      .select()
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.id, attemptId),
          eq(paymentAttempts.orderId, order.id)
        )
      )
      .for("update");
    if (attempt?.state !== "paid") return false;
    if (!unavailable && attempt.refundState === "not_required") return true;
    if (!unavailable && isUnsolicitedPartialPassRefund(attempt)) {
      yield* Effect.logWarning(
        "Unlimited pass activation after an unsolicited partial refund needs operational review",
        { orderId: order.id }
      );
      return true;
    }

    const [ended] = yield* db
      .update(passPurchases)
      .set({ status: "void" })
      .where(
        and(
          eq(passPurchases.id, order.id),
          eq(passPurchases.product, "unlimited"),
          eq(passPurchases.status, "pending_payment")
        )
      )
      .returning({ id: passPurchases.id });
    if (!ended) return false;

    const now = yield* currentInstant;
    if (unavailable) yield* requireFullPassRefund(attempt, now);
    yield* db
      .update(orders)
      .set({
        fulfillmentState: "failed",
        fulfillmentFailedAt: now,
        fulfillmentFailureCode: unavailable
          ? "unlimited_pass_day_unavailable"
          : "unlimited_pass_payment_refunded",
        updatedAt: now,
      })
      .where(eq(orders.id, order.id));
    return false;
  }
);

export const canConfirmUnlimitedPass = Effect.fn("canConfirmUnlimitedPass")(
  function* (id: OrderId, attemptId: PaymentAttemptId, unavailable = false) {
    const { db, transaction } = yield* WorkspaceDatabase;
    return yield* transaction(
      Effect.gen(function* () {
        const [order] = yield* db
          .select()
          .from(orders)
          .where(eq(orders.id, id))
          .for("no key update");
        return order
          ? yield* checkUnlimitedActivation(order, attemptId, unavailable)
          : false;
      })
    );
  }
);

/** Reconcile the pack from the authoritative order after shared settlement. */
export const settlePassPurchase = Effect.fn("settlePassPurchase")(function* (
  id: OrderId,
  confirmedAttemptId?: PaymentAttemptId
) {
  const { db, transaction } = yield* WorkspaceDatabase;
  return yield* transaction(
    Effect.gen(function* () {
      const [order] = yield* db
        .select()
        .from(orders)
        .where(and(eq(orders.id, id), eq(orders.kind, "pass-purchase")))
        .for("no key update");

      if (!order) return undefined;

      const [pass] = yield* db
        .select({ product: passPurchases.product })
        .from(passPurchases)
        .where(eq(passPurchases.id, id));
      if (!pass) return undefined;

      if (order.paymentState === "paid") {
        if (pass.product === "unlimited" && !confirmedAttemptId) {
          yield* db
            .update(workspaceReservations)
            .set({
              reservationState: "confirming",
              paymentState: "paid",
              fulfillmentState: "processing",
              paidAt: order.paidAt,
              updatedAt: order.updatedAt,
            })
            .where(
              and(
                eq(workspaceReservations.passId, id),
                eq(workspaceReservations.reservationState, "held")
              )
            );
          return undefined;
        }
        if (
          pass.product === "unlimited" &&
          confirmedAttemptId &&
          !(yield* checkUnlimitedActivation(order, confirmedAttemptId))
        )
          return undefined;
        const activatedAt = yield* currentInstant;
        const [purchase] = yield* db
          .update(passPurchases)
          .set({
            status: "active",
            giftIssuedAt: sql`case when ${passPurchases.buyerAccountId} <> ${passPurchases.holderAccountId}
              then ${activatedAt.toString()}::timestamptz end`,
          })
          .where(
            and(
              eq(passPurchases.id, id),
              inArray(passPurchases.status, ["pending_payment", "void"])
            )
          )
          .returning();
        if (purchase) yield* queueInitialEntryPackGift(purchase, activatedAt);
        return purchase;
      }

      if (isEndedUnpaidPaymentState(order.paymentState)) {
        if (pass.product === "unlimited") {
          yield* db
            .update(workspaceReservations)
            .set({
              paymentState: order.paymentState,
              updatedAt: order.updatedAt,
            })
            .where(eq(workspaceReservations.passId, id));
        }
        yield* db
          .update(passPurchases)
          .set({ status: "void" })
          .where(
            and(
              eq(passPurchases.id, id),
              eq(passPurchases.status, "pending_payment")
            )
          );
      }
      return undefined;
    })
  );
});
