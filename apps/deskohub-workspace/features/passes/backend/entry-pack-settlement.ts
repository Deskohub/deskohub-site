import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { orders, passPurchases } from "@/db/schema";
import { isEndedUnpaidPaymentState, type OrderId } from "@/features/order";
import { currentInstant } from "@/shared/utils/temporal";
import { queueInitialEntryPackGift } from "./entry-pack-gift";

/** Reconcile the pack from the authoritative order after shared settlement. */
export const settleEntryPack = Effect.fn("settleEntryPack")(function* (
  id: OrderId
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

      if (order.paymentState === "paid") {
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
