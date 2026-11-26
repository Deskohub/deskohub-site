import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import { WorkspaceDatabase, WorkspaceTransaction } from "@/db/database.service";
import {
  unlimitedAutoRenewalAuthorizations as authorizations,
  orders,
  passPurchases,
  paymentAttempts,
} from "@/db/schema";
import { CustomerAccountSections } from "@/features/account/backend/customer-account-sections";
import type { CustomerAccountId } from "@/features/account/customer-account";
import type { PaymentAttemptId } from "@/features/checkout/checkout-identifiers";
import type { Locale } from "@/features/i18n";
import { getLegalDocumentVersion } from "@/features/legal/document-version";
import { getLegalDocumentPath } from "@/features/legal/legal-document-path";
import { supportsUnlimitedAutoRenewalTerms } from "@/features/legal/unlimited-auto-renewal-terms";
import type { OrderId } from "@/features/order";
import { type Money, moneyEquals } from "@/shared/money/money";
import { currentInstant, type PlainDate } from "@/shared/utils/temporal";
import { getUnlimitedPassPrice } from "../pass-offer";
import { withPassPurchaseAddons } from "../pass-purchase-quote";
import type {
  UnlimitedAutoRenewalAuthorization,
  UnlimitedAutoRenewalDisclosure,
} from "../unlimited-auto-renewal";
import { isUnlimitedAutoRenewalPreviewEnabled } from "./unlimited-auto-renewal-preview.server";

type RenewalPurchase = Pick<
  typeof passPurchases.$inferSelect,
  "autoRenew" | "locale" | "tier" | "unlimitedCoffee" | "validUntil"
>;

export const offersUnlimitedAutoRenewal = (locale: Locale) =>
  isUnlimitedAutoRenewalPreviewEnabled() &&
  supportsUnlimitedAutoRenewalTerms(locale);

export function readUnlimitedAutoRenewalDisclosure(
  purchase: RenewalPurchase
): UnlimitedAutoRenewalDisclosure | undefined {
  if (!purchase.autoRenew || !offersUnlimitedAutoRenewal(purchase.locale)) {
    return undefined;
  }

  return {
    amount: withPassPurchaseAddons(
      getUnlimitedPassPrice({ kind: "unlimited", tier: purchase.tier }),
      purchase.unlimitedCoffee
    ),
    nextRenewalOn: purchase.validUntil,
    termsHash: getLegalDocumentVersion(purchase.locale, "terms-and-conditions"),
    termsPath: getLegalDocumentPath(purchase.locale, "terms-and-conditions"),
  };
}

export const matchesUnlimitedAutoRenewalAuthorization = (
  accepted: UnlimitedAutoRenewalAuthorization | undefined,
  disclosed: UnlimitedAutoRenewalDisclosure
) =>
  accepted !== undefined &&
  accepted.termsHash === disclosed.termsHash &&
  accepted.nextRenewalOn === disclosed.nextRenewalOn &&
  moneyEquals(accepted.amount, disclosed.amount);

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
        eq(passPurchases.product, "unlimited"),
        orderId === undefined ? undefined : eq(passPurchases.id, orderId),
        eq(passPurchases.autoRenew, true),
        eq(passPurchases.buyerAccountId, accountId),
        eq(passPurchases.holderAccountId, accountId),
        eq(passPurchases.holderVersion, authorizations.holderVersion),
        inArray(passPurchases.status, ["active", "expired"]),
        eq(orders.kind, "pass-purchase"),
        eq(orders.paymentState, "paid"),
        eq(paymentAttempts.state, "paid"),
        eq(paymentAttempts.refundState, "not_required")
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
          status: row.cancelledAt ? "cancelled" : "pending",
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
        if (!renewal.cancelledAt) {
          const cancelledAt = yield* currentInstant;
          yield* db
            .update(authorizations)
            .set({ cancelledAt })
            .where(
              eq(authorizations.paymentAttemptId, renewal.paymentAttemptId)
            );
        }
        return "cancelled" as const;
      })
    ),
    { passPurchaseOrderId: orderId }
  );
});
