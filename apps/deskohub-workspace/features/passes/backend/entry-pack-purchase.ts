import "server-only";

import { eq } from "drizzle-orm";
import { Data, Effect, Schema } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { orders, passPurchases } from "@/db/schema";
import { CurrentCustomerAccount } from "@/features/account/backend/current-customer-account";
import {
  ensurePassHolderAccount,
  findPassHolderAccount,
} from "@/features/account/backend/customer-account-by-email";
import { CustomerAccountContactService } from "@/features/account/backend/customer-account-contact.service";
import { CustomerAccountSections } from "@/features/account/backend/customer-account-sections";
import type { CustomerProfileSave } from "@/features/account/contracts";
import type { CustomerAccountId } from "@/features/account/customer-account";
import { LegalEvidenceEventRepository } from "@/features/checkout/backend/repositories/legal-evidence-event.repository";
import {
  type CanonicalPromotionCode,
  discountQuoteCodec,
} from "@/features/discounts/contracts";
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
import { currentInstant } from "@/shared/utils/temporal";
import type { EntryPackProduct } from "../pass-offer";
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
