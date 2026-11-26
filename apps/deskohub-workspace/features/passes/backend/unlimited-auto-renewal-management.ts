import "server-only";

import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import {
  unlimitedAutoRenewalAuthorizations as authorizations,
  orders,
  passPurchases,
  paymentAttempts,
} from "@/db/schema";
import { CustomerAccountSections } from "@/features/account/backend/customer-account-sections";
import type { CustomerAccountId } from "@/features/account/customer-account";
import type { OrderId } from "@/features/order";
import type { Money } from "@/shared/money/money";
import { currentInstant, type PlainDate } from "@/shared/utils/temporal";
import {
  eligibleUnlimitedRenewalSource,
  unlimitedRenewalIntentOpen,
} from "./unlimited-auto-renewal-ledger";

type UnlimitedAutoRenewal = {
  readonly status: "pending" | "cancelled";
  readonly nextRenewalOn: PlainDate;
  readonly amount: Money;
};

const ownedUnlimitedAutoRenewals = Effect.fnUntraced(function* (
  accountId: CustomerAccountId,
  orderId?: OrderId
) {
  const { db } = yield* WorkspaceDatabase;
  return db
    .select({
      orderId: passPurchases.id,
      paymentAttemptId: authorizations.paymentAttemptId,
      nextRenewalOn: authorizations.nextRenewalOn,
      amountValue: authorizations.amountValue,
      amountExponent: authorizations.amountExponent,
      currency: authorizations.currency,
      cancelledAt: authorizations.cancelledAt,
      prepaidSuccessorOrderId: authorizations.prepaidSuccessorOrderId,
    })
    .from(passPurchases)
    .innerJoin(orders, eq(orders.id, passPurchases.id))
    .innerJoin(
      paymentAttempts,
      and(
        eq(paymentAttempts.orderId, orders.id),
        eq(paymentAttempts.id, orders.activePaymentAttemptId)
      )
    )
    .innerJoin(
      authorizations,
      eq(authorizations.paymentAttemptId, paymentAttempts.id)
    )
    .where(
      and(
        orderId === undefined ? undefined : eq(passPurchases.id, orderId),
        eq(passPurchases.holderAccountId, accountId),
        eligibleUnlimitedRenewalSource
      )
    );
});

/** The paid, active pass and its winning attempt establish the renewal intent. */
export const listUnlimitedAutoRenewals = Effect.fn("listUnlimitedAutoRenewals")(
  function* (accountId: CustomerAccountId) {
    const query = yield* ownedUnlimitedAutoRenewals(accountId);
    const rows = yield* query;
    return new Map<OrderId, UnlimitedAutoRenewal>(
      rows.map((row) => [
        row.orderId,
        {
          status:
            row.cancelledAt || row.prepaidSuccessorOrderId
              ? "cancelled"
              : "pending",
          nextRenewalOn: row.nextRenewalOn,
          amount: {
            value: row.amountValue,
            exponent: row.amountExponent,
            currency: row.currency,
          },
        },
      ])
    );
  }
);

export const cancelUnlimitedAutoRenewal = Effect.fn(
  "cancelUnlimitedAutoRenewal"
)(function* (accountId: CustomerAccountId, orderId: OrderId) {
  const accounts = yield* CustomerAccountSections;
  const { db, transaction } = yield* WorkspaceDatabase;
  return yield* accounts.withActiveAccount(
    accountId,
    transaction(
      Effect.gen(function* () {
        // Payment and pass lifecycle mutations lock this row before changing the pass.
        const [order] = yield* db
          .select({ id: orders.id })
          .from(orders)
          .innerJoin(passPurchases, eq(passPurchases.id, orders.id))
          .where(
            and(
              eq(orders.id, orderId),
              eq(orders.kind, "pass-purchase"),
              eq(passPurchases.buyerAccountId, accountId),
              eq(passPurchases.holderAccountId, accountId)
            )
          )
          .for("no key update", { of: orders });
        if (!order) return "unavailable" as const;
        const query = yield* ownedUnlimitedAutoRenewals(accountId, orderId);
        const [renewal] = yield* query;
        if (!renewal) return "unavailable" as const;
        if (!renewal.cancelledAt && !renewal.prepaidSuccessorOrderId) {
          const cancelledAt = yield* currentInstant;
          yield* db
            .update(authorizations)
            .set({ cancelledAt })
            .where(
              and(
                eq(authorizations.paymentAttemptId, renewal.paymentAttemptId),
                unlimitedRenewalIntentOpen
              )
            );
        }
        return "cancelled" as const;
      })
    ),
    { passPurchaseOrderId: orderId }
  );
});
