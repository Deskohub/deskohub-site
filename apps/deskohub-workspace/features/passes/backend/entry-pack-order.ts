import "server-only";

import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { orders, passPurchases, paymentAttempts } from "@/db/schema";
import { CurrentCustomerAccount } from "@/features/account/backend/current-customer-account";
import type { CustomerAccountId } from "@/features/account/customer-account";
import type { OrderId } from "@/features/order";

export const findOwnedEntryPackOrder = Effect.fn("findOwnedEntryPackOrder")(
  function* (orderId: OrderId, buyerAccountId: CustomerAccountId) {
    const { db } = yield* WorkspaceDatabase;
    const [entry] = yield* db
      .select({
        order: orders,
        purchase: passPurchases,
        activeAttempt: {
          state: paymentAttempts.state,
          refundState: paymentAttempts.refundState,
        },
      })
      .from(passPurchases)
      .innerJoin(orders, eq(orders.id, passPurchases.id))
      .leftJoin(
        paymentAttempts,
        and(
          eq(paymentAttempts.id, orders.activePaymentAttemptId),
          eq(paymentAttempts.orderId, orders.id)
        )
      )
      .where(
        and(
          eq(passPurchases.id, orderId),
          eq(passPurchases.buyerAccountId, buyerAccountId),
          eq(orders.kind, "pass-purchase")
        )
      );
    return entry;
  }
);

/** The issued locale is visible only to the active, verified buyer. */
export const readOwnedEntryPackOrderLocale = Effect.fn(
  "readOwnedEntryPackOrderLocale"
)(function* (orderId: OrderId) {
  const current = yield* CurrentCustomerAccount;
  const session = yield* current.requireActive.pipe(
    Effect.catchTag("CustomerAccountAccessError", (error) =>
      error.reason === "unavailable" ? Effect.fail(error) : Effect.undefined
    )
  );
  if (!session) return undefined;
  const entry = yield* findOwnedEntryPackOrder(orderId, session.accountId);
  return entry?.purchase.locale;
});
