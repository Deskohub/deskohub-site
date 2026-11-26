import "server-only";

import { and, eq, exists, gte, inArray, isNull, lt } from "drizzle-orm";
import { Effect } from "effect";
import { WorkspaceTransaction } from "@/db/database.service";
import {
  unlimitedAutoRenewalAuthorizations as authorizations,
  orders,
  passPurchases,
  paymentAttempts,
} from "@/db/schema";
import type { PaymentAttemptId } from "@/features/checkout/checkout-identifiers";
import type { UnlimitedAutoRenewalDisclosure } from "../unlimited-auto-renewal";

// Both ways to stop an intent compete on this predicate on the same row.
export const unlimitedRenewalIntentOpen = and(
  isNull(authorizations.cancelledAt),
  isNull(authorizations.prepaidSuccessorOrderId)
);

export const eligibleUnlimitedRenewalSource = and(
  eq(passPurchases.product, "unlimited"),
  eq(passPurchases.autoRenew, true),
  eq(passPurchases.buyerAccountId, passPurchases.holderAccountId),
  eq(passPurchases.holderVersion, authorizations.holderVersion),
  inArray(passPurchases.status, ["active", "expired"]),
  eq(orders.kind, "pass-purchase"),
  eq(orders.paymentState, "paid"),
  eq(paymentAttempts.state, "paid"),
  eq(paymentAttempts.refundState, "not_required")
);

export const recordUnlimitedAutoRenewalAuthorization = Effect.fn(
  "recordUnlimitedAutoRenewalAuthorization"
)(function* (
  paymentAttemptId: PaymentAttemptId,
  holderVersion: number,
  disclosure: UnlimitedAutoRenewalDisclosure,
  quoteFingerprint: string,
  acceptedAt: Temporal.Instant
) {
  const { db } = yield* WorkspaceTransaction;
  yield* db.insert(authorizations).values({
    paymentAttemptId,
    holderVersion,
    nextRenewalOn: disclosure.nextRenewalOn,
    amountValue: disclosure.amount.value,
    amountExponent: disclosure.amount.exponent,
    currency: disclosure.amount.currency,
    termsPath: disclosure.termsPath,
    termsHash: disclosure.termsHash,
    quoteFingerprint,
    acceptedAt,
  });
});

/** A newly activated self-purchase covers any planned renewal day inside its paid period. */
export const recordPrepaidRenewalCoverage = Effect.fn(
  "recordPrepaidRenewalCoverage"
)(function* (purchase: typeof passPurchases.$inferSelect) {
  if (
    purchase.product !== "unlimited" ||
    purchase.buyerAccountId !== purchase.holderAccountId
  ) {
    return;
  }

  const { db } = yield* WorkspaceTransaction;
  const source = db
    .select({ id: orders.id })
    .from(orders)
    .innerJoin(passPurchases, eq(passPurchases.id, orders.id))
    .innerJoin(
      paymentAttempts,
      and(
        eq(paymentAttempts.orderId, orders.id),
        eq(paymentAttempts.id, orders.activePaymentAttemptId)
      )
    )
    .where(
      and(
        eq(paymentAttempts.id, authorizations.paymentAttemptId),
        eq(passPurchases.holderAccountId, purchase.holderAccountId),
        eligibleUnlimitedRenewalSource
      )
    );
  yield* db
    .update(authorizations)
    .set({ prepaidSuccessorOrderId: purchase.id })
    .where(
      and(
        unlimitedRenewalIntentOpen,
        gte(authorizations.nextRenewalOn, purchase.validFrom),
        lt(authorizations.nextRenewalOn, purchase.validUntil),
        exists(source)
      )
    );
});
