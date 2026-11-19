import "server-only";

import { and, eq } from "drizzle-orm";
import { Data, Effect, Schema } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { orders, passPurchases, paymentAttempts } from "@/db/schema";
import { CurrentCustomerAccount } from "@/features/account/backend/current-customer-account";
import {
  ensurePassHolderAccount,
  findPassHolderAccount,
} from "@/features/account/backend/customer-account-by-email";
import { CustomerAccountContactService } from "@/features/account/backend/customer-account-contact.service";
import { CustomerAccountSections } from "@/features/account/backend/customer-account-sections";
import type { CustomerProfileSave } from "@/features/account/contracts";
import type { CustomerAccountId } from "@/features/account/customer-account";
import { CheckoutAnalytics } from "@/features/checkout/backend/analytics/checkout-analytics.service";
import { startNexiPaymentSession } from "@/features/checkout/backend/payment/nexi-payment-session";
import { OrderPaymentHandlers } from "@/features/checkout/backend/payment/order-payment-handlers.service";
import { LegalEvidenceEventRepository } from "@/features/checkout/backend/repositories/legal-evidence-event.repository";
import {
  type CanonicalPromotionCode,
  discountQuoteCodec,
} from "@/features/discounts/contracts";
import { DiscountService } from "@/features/discounts/discount.service";
import { WorkspaceFeatureFlagService } from "@/features/feature-flags/backend/workspace-feature-flag.service";
import { type Locale, m } from "@/features/i18n";
import {
  getPaymentSubmitLegalDocuments,
  getPaymentSubmitLegalEvidence,
  isCurrentPaymentSubmitLegalAcceptance,
} from "@/features/legal/payment-submit-evidence";
import type { OrderId } from "@/features/order";
import type { DotyposCustomerId } from "@/features/reservation/dotypos-customer";
import { reservationCustomerEmailSchema } from "@/features/reservation/reservation-contact";
import { reservationStatusPath } from "@/features/reservation/routes";
import { moneyEquals } from "@/shared/money/money";
import { currentInstant } from "@/shared/utils/temporal";
import { type EntryPackProduct, getEntryPackPrice } from "../pass-offer";
import { quoteEntryPack } from "./entry-pack-quote";

class EntryPackPurchaseError extends Data.TaggedError(
  "EntryPackPurchaseError"
)<{
  readonly reason:
    | "unavailable"
    | "buyer-profile-required"
    | "holder-unavailable"
    | "purchase-conflict"
    | "consent-required"
    | "terms-changed";
}> {}

const requirePassPurchasesEnabled = Effect.fn("requirePassPurchasesEnabled")(
  function* () {
    const flags = yield* WorkspaceFeatureFlagService;
    if (!(yield* flags.isEnabled("cowork_passes"))) {
      return yield* new EntryPackPurchaseError({ reason: "unavailable" });
    }
  }
);

const readPurchase = Effect.fn("readEntryPackPurchase")(function* (
  id: OrderId
) {
  const { db } = yield* WorkspaceDatabase;
  const [purchase] = yield* db
    .select()
    .from(passPurchases)
    .where(eq(passPurchases.id, id));
  return purchase;
});

const verifyRetry = Effect.fn("verifyEntryPackPurchaseRetry")(function* (
  purchase: typeof passPurchases.$inferSelect,
  input: {
    readonly buyerAccountId: CustomerAccountId;
    readonly product: EntryPackProduct;
    readonly holderEmail: string | null;
  }
) {
  if (
    purchase.buyerAccountId !== input.buyerAccountId ||
    purchase.tier !== input.product.tier ||
    purchase.entryCount !== input.product.size
  ) {
    return yield* new EntryPackPurchaseError({ reason: "purchase-conflict" });
  }
  const holderAccountId =
    input.holderEmail === null
      ? input.buyerAccountId
      : yield* findPassHolderAccount(input.holderEmail);
  if (purchase.holderAccountId !== holderAccountId) {
    return yield* new EntryPackPurchaseError({ reason: "purchase-conflict" });
  }
  return purchase;
});

/** Continue creates the order and pending pack in one transaction. Reuse its ID on retry. */
export const beginEntryPackPurchase = Effect.fn("beginEntryPackPurchase")(
  function* (input: {
    readonly orderId: OrderId;
    readonly product: EntryPackProduct;
    readonly locale: Locale;
    readonly holderEmail?: string;
    readonly buyerProfile?: CustomerProfileSave;
    readonly submittedCode?: CanonicalPromotionCode;
    readonly referralCode?: CanonicalPromotionCode;
  }) {
    yield* requirePassPurchasesEnabled();
    const current = yield* CurrentCustomerAccount;
    const session = yield* current.requireActive;
    const accounts = yield* CustomerAccountSections;
    const { db, transaction } = yield* WorkspaceDatabase;
    const contacts = yield* CustomerAccountContactService;
    const holderEmail =
      input.holderEmail === undefined
        ? null
        : yield* Schema.decodeUnknownEffect(reservationCustomerEmailSchema)(
            input.holderEmail
          );
    const giftEmail =
      holderEmail?.toLowerCase() === session.email.toLowerCase()
        ? null
        : holderEmail;
    const retry = {
      buyerAccountId: session.accountId,
      product: input.product,
      holderEmail: giftEmail,
    };

    return yield* accounts.withActiveAccount(
      session.accountId,
      Effect.gen(function* () {
        const existing = yield* readPurchase(input.orderId);
        if (existing) return yield* verifyRetry(existing, retry);

        const standing = yield* current.peek;
        let dotyposCustomerId: DotyposCustomerId | undefined;
        if (standing.kind === "linked") {
          dotyposCustomerId = standing.account.dotyposCustomerId;
        } else if (standing.kind === "unlinked" && input.buyerProfile) {
          const contact = yield* contacts.completeProfile(
            session,
            input.buyerProfile
          );
          dotyposCustomerId = contact?.dotyposCustomerId;
        } else if (standing.kind === "unavailable") {
          return yield* standing.failure;
        }
        if (!dotyposCustomerId) {
          return yield* new EntryPackPurchaseError({
            reason: "buyer-profile-required",
          });
        }

        const purchasedAt = yield* currentInstant;
        const { quote, validFrom, validUntil } = yield* quoteEntryPack({
          ...input,
          buyer: dotyposCustomerId,
          purchasedAt,
        });
        const acceptedQuote =
          yield* Schema.encodeEffect(discountQuoteCodec)(quote);

        return yield* transaction(
          Effect.gen(function* () {
            const [order] = yield* db
              .insert(orders)
              .values({
                id: input.orderId,
                kind: "pass-purchase",
                dotyposCustomerId,
                paymentState: "not_started",
                fulfillmentState: "not_started",
              })
              .onConflictDoNothing({ target: orders.id })
              .returning({ id: orders.id });

            if (!order) {
              const competing = yield* readPurchase(input.orderId);
              if (!competing) {
                return yield* new EntryPackPurchaseError({
                  reason: "purchase-conflict",
                });
              }
              return yield* verifyRetry(competing, retry);
            }

            const holderAccountId =
              giftEmail === null
                ? session.accountId
                : yield* ensurePassHolderAccount(giftEmail);
            if (!holderAccountId) {
              return yield* new EntryPackPurchaseError({
                reason: "holder-unavailable",
              });
            }

            const [purchase] = yield* db
              .insert(passPurchases)
              .values({
                id: order.id,
                buyerAccountId: session.accountId,
                holderAccountId,
                product: input.product.kind,
                tier: input.product.tier,
                entryCount: input.product.size,
                quote: acceptedQuote,
                status: "pending_payment",
                validFrom,
                validUntil,
                locale: input.locale,
                createdAt: purchasedAt,
              })
              .returning();

            if (!purchase)
              return yield* Effect.die("Entry pack insert returned no row.");
            return purchase;
          })
        );
      })
    );
  }
);

export const getEntryPackPaymentDisclosure = (locale: Locale) => ({
  documents: getPaymentSubmitLegalDocuments(locale),
  earlyStartRequest: m.passEarlyStartConsent({}, { locale }),
});

/** Pay records the versions and the buyer's express request before starting payment. */
export const recordEntryPackPaymentConsent = Effect.fn(
  "recordEntryPackPaymentConsent"
)(function* (input: {
  readonly orderId: OrderId;
  readonly accepted: boolean;
  readonly acceptedDocuments: ReadonlyArray<{
    readonly key: string;
    readonly hash: string;
  }>;
}) {
  yield* requirePassPurchasesEnabled();
  const current = yield* CurrentCustomerAccount;
  const session = yield* current.requireActive;
  const purchase = yield* readPurchase(input.orderId);
  if (!purchase || purchase.buyerAccountId !== session.accountId) {
    return yield* new EntryPackPurchaseError({ reason: "unavailable" });
  }
  if (!input.accepted) {
    return yield* new EntryPackPurchaseError({ reason: "consent-required" });
  }
  if (
    !isCurrentPaymentSubmitLegalAcceptance(
      purchase.locale,
      input.acceptedDocuments
    )
  ) {
    return yield* new EntryPackPurchaseError({ reason: "terms-changed" });
  }

  const evidence = yield* LegalEvidenceEventRepository;
  const acceptedAt = yield* currentInstant;
  const { transaction } = yield* WorkspaceDatabase;
  yield* transaction(
    evidence.recordMany(
      Object.values(
        getPaymentSubmitLegalEvidence({
          acceptedAt: acceptedAt.toString(),
          locale: purchase.locale,
          earlyPerformanceConsent: true,
          entryPackEarlyStartRequested: true,
        })
      ).map((record) => ({ orderId: purchase.id, evidence: record }))
    )
  );
});

/** Starts the payment for the authenticated buyer after reconfirming the displayed quote. */
export const payForEntryPack = Effect.fn("payForEntryPack")(function* (
  input: Parameters<typeof recordEntryPackPaymentConsent>[0] & {
    readonly submittedCode?: CanonicalPromotionCode;
    readonly referralCode?: CanonicalPromotionCode;
  }
) {
  yield* requirePassPurchasesEnabled();
  const current = yield* CurrentCustomerAccount;
  const session = yield* current.requireActive;
  const accounts = yield* CustomerAccountSections;
  const { db } = yield* WorkspaceDatabase;
  const handlers = yield* OrderPaymentHandlers;
  const handler = handlers.byKind["pass-purchase"];
  if (!handler)
    return yield* new EntryPackPurchaseError({ reason: "unavailable" });

  return yield* accounts.withActiveAccount(
    session.accountId,
    Effect.gen(function* () {
      const [entry] = yield* db
        .select({ order: orders, purchase: passPurchases })
        .from(passPurchases)
        .innerJoin(orders, eq(orders.id, passPurchases.id))
        .where(
          and(
            eq(passPurchases.id, input.orderId),
            eq(passPurchases.buyerAccountId, session.accountId),
            eq(orders.kind, "pass-purchase")
          )
        );
      if (!entry)
        return yield* new EntryPackPurchaseError({ reason: "unavailable" });
      const { order, purchase } = entry;
      const statusUrl = `/${purchase.locale}${reservationStatusPath}/${order.id}`;
      if (order.paymentState === "paid") {
        yield* handler.scheduleFulfillment({ orderId: order.id });
        return { status: "paid" as const, statusUrl };
      }
      if (order.paymentState === "pending" && order.activePaymentAttemptId) {
        const [attempt] = yield* db
          .select({ redirect: paymentAttempts.providerRedirectUrl })
          .from(paymentAttempts)
          .where(
            and(
              eq(paymentAttempts.id, order.activePaymentAttemptId),
              eq(paymentAttempts.orderId, order.id)
            )
          );
        return attempt?.redirect
          ? {
              status: "hosted" as const,
              statusUrl,
              redirectUrl: attempt.redirect,
            }
          : { status: "pending" as const, statusUrl };
      }

      const discountService = yield* DiscountService;
      const product = {
        kind: "entry-pack",
        tier: purchase.tier,
        size: purchase.entryCount,
      } as const;
      const accepted = yield* Schema.decodeUnknownEffect(discountQuoteCodec)(
        purchase.quote
      );
      const { quote, commitment } =
        yield* discountService.affirmDisplayedDiscounts({
          product,
          discountableSubtotal: getEntryPackPrice(product),
          firstServiceDate: purchase.validFrom,
          lastServiceDate: purchase.validFrom,
          bookedAt: yield* currentInstant,
          dotyposCustomerId: order.dotyposCustomerId,
          locale: purchase.locale,
          displayedDiscountIds: accepted.discounts.map(
            ({ discount }) => discount.id
          ),
          ...(input.submittedCode !== undefined && {
            submittedCode: input.submittedCode,
          }),
          ...(input.referralCode !== undefined && {
            referralCode: input.referralCode,
          }),
        });
      if (
        !moneyEquals(
          accepted.discountableSubtotal,
          quote.discountableSubtotal
        ) ||
        !moneyEquals(accepted.discountedSubtotal, quote.discountedSubtotal) ||
        accepted.discounts.length !== quote.discounts.length ||
        !accepted.discounts.every(
          (application, index) =>
            application.discount.id === quote.discounts[index]?.discount.id &&
            moneyEquals(application.amount, quote.discounts[index]?.amount)
        )
      ) {
        return { status: "pricing_changed" as const, quote };
      }

      const admission = {
        orderId: order.id,
        amount: quote.discountedSubtotal,
        locale: purchase.locale,
        details: { commitment },
      };
      const analytics = yield* CheckoutAnalytics;
      if (admission.amount.value === 0) {
        yield* recordEntryPackPaymentConsent(input);
        const payment = yield* handler.admitInternal(admission);
        if (payment.changed)
          yield* analytics.paymentCompleted({
            attempt: payment.attempt,
            timestamp: payment.timestamp,
          });
        yield* handler.scheduleFulfillment({ orderId: order.id });
        return { status: "paid" as const, statusUrl };
      }

      const contacts = yield* CustomerAccountContactService;
      const contact = yield* contacts.linkedContact({
        accountId: session.accountId,
        email: session.email,
        dotyposCustomerId: order.dotyposCustomerId,
      });
      if (!contact)
        return yield* new EntryPackPurchaseError({
          reason: "buyer-profile-required",
        });
      const { hostedPaymentPage, attachedAttempt } =
        yield* startNexiPaymentSession({
          ...admission,
          kind: "pass-purchase",
          correlationId: order.correlationId,
          customer: { name: contact.name, email: session.email },
          beforeAttempt: recordEntryPackPaymentConsent(input),
        }).pipe(Effect.scoped);
      yield* analytics.paymentStarted({
        attempt: attachedAttempt,
        timestamp: attachedAttempt.updatedAt,
      });
      return {
        status: "hosted" as const,
        statusUrl,
        redirectUrl: hostedPaymentPage.hostedPage,
      };
    })
  );
});
