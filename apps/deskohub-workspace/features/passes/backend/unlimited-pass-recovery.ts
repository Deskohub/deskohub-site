import "server-only";

import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { orders, passPurchases } from "@/db/schema";
import { WorkspaceLockSections } from "@/db/workspace-locks";
import type { PaymentAttemptId } from "@/features/checkout/checkout-identifiers";
import { isEndedUnpaidPaymentState, type OrderId } from "@/features/order";
import { currentInstant, plainDateStringSchema } from "@/shared/utils/temporal";
import { unlimitedPassDays } from "../pass-offer";
import { withUnlimitedPassCapacity } from "./unlimited-pass-capacity";
import {
  createUnlimitedPassHolds,
  readUnlimitedPassDays,
  reconfirmUnlimitedPassHolds,
  releaseUnlimitedPassDays,
} from "./unlimited-pass-holds";
import {
  readUnlimitedPassSelection,
  recordReplacementUnlimitedPassHolds,
} from "./unlimited-pass-orders";

/** No provider writes run in the transaction that settles the verified payment. */
export const prepareUnlimitedPassRecovery = Effect.fn(
  "prepareUnlimitedPassRecovery"
)(function* (orderId: OrderId, attemptId: PaymentAttemptId) {
  const { db, transaction } = yield* WorkspaceDatabase;
  const load = Effect.gen(function* () {
    const [entry] = yield* db
      .select({ order: orders, purchase: passPurchases })
      .from(orders)
      .innerJoin(passPurchases, eq(orders.id, passPurchases.id))
      .where(
        and(eq(orders.id, orderId), eq(passPurchases.product, "unlimited"))
      );
    if (
      entry?.order.activePaymentAttemptId === attemptId &&
      isEndedUnpaidPaymentState(entry.order.paymentState)
    ) {
      return entry.purchase;
    }
  });

  const previous = yield* Effect.gen(function* () {
    const purchase = yield* load;
    if (
      !purchase ||
      (purchase.status !== "void" && purchase.status !== "pending_payment")
    )
      return undefined;
    if (purchase.status === "void") {
      yield* releaseUnlimitedPassDays(purchase);
      const days = yield* readUnlimitedPassDays(orderId);
      if (
        days.length !== unlimitedPassDays ||
        days.some(
          (day) =>
            day.reservationState !== "cancelled" &&
            day.reservationState !== "hold_expired"
        )
      ) {
        return undefined;
      }
    }
    return purchase;
  }).pipe(WorkspaceLockSections.passPurchaseFulfillment(orderId));
  if (!previous) return false;

  if (previous.status === "void") {
    const selection = readUnlimitedPassSelection(previous);
    if (!selection) return false;
    const now = yield* currentInstant;
    yield* withUnlimitedPassCapacity(
      {
        selection,
        startDate: Temporal.PlainDate.from(previous.validFrom),
      },
      ({ days }) =>
        transaction(
          recordReplacementUnlimitedPassHolds({
            purchase: previous,
            paidAttemptId: attemptId,
            days: days.map((day) => ({
              ...day,
              serviceDate: plainDateStringSchema.make(
                day.serviceDate.toString()
              ),
            })),
            now,
          })
        )
    );
  }

  return yield* Effect.gen(function* () {
    const purchase = yield* load;
    if (purchase?.status !== "pending_payment") return false;
    yield* createUnlimitedPassHolds(purchase);
    yield* reconfirmUnlimitedPassHolds(purchase);
    return true;
  }).pipe(WorkspaceLockSections.passPurchaseFulfillment(orderId));
});
