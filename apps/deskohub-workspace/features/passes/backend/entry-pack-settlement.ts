import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { orders, passPurchases } from "@/db/schema";
import { isEndedUnpaidPaymentState, type OrderId } from "@/features/order";
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
        const [purchase] = yield* db
          .update(passPurchases)
          .set({ status: "active" })
          .where(
            and(
              eq(passPurchases.id, id),
              inArray(passPurchases.status, ["pending_payment", "void"])
            )
          )
          .returning();
        if (purchase) yield* queueInitialEntryPackGift(purchase);
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
