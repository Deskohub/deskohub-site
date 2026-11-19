import "server-only";

import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { Data, Effect, Schema } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import {
  discountApplications,
  orders,
  passPurchases,
  paymentAttempts,
} from "@/db/schema";
import { CurrentCustomerAccount } from "@/features/account/backend/current-customer-account";
import {
  ensurePassHolderAccount,
  findPassHolderAccount,
  findPurchaseLoginEmail,
} from "@/features/account/backend/customer-account-by-email";
import { CustomerAccountContactService } from "@/features/account/backend/customer-account-contact.service";
import { CustomerAccountSections } from "@/features/account/backend/customer-account-sections";
import type { CustomerProfileSave } from "@/features/account/contracts";
import type { CustomerAccountId } from "@/features/account/customer-account";
import { workspaceAccountingSupplier } from "@/features/accounting/accounting-document-snapshot";
import { AccountingDocumentSnapshots } from "@/features/accounting/backend/accounting-document-snapshots";
import { CheckoutAnalytics } from "@/features/checkout/backend/analytics/checkout-analytics.service";
import { PaymentPageProviderStatus } from "@/features/checkout/backend/checkout/payment-page-provider-status";
import {
  decidePaymentPageReopening,
  getPaymentPageToReopen,
} from "@/features/checkout/backend/checkout/reusable-payment-attempt";
import { OrderPaymentHandlers } from "@/features/checkout/backend/payment/order-payment-handlers.service";
import { startPaymentSession } from "@/features/checkout/backend/payment/payment-session";
import { LegalEvidenceEventRepository } from "@/features/checkout/backend/repositories/legal-evidence-event.repository";
import { getDiscountCommitmentPayload } from "@/features/discounts/commitment";
import type { CanonicalPromotionCode } from "@/features/discounts/contracts";
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
import {
  defaultReservationBillingSelection,
  getReservationInvoiceBuyer,
  type ReservationBillingSelection,
  reservationBillingSelectionSchema,
} from "@/features/reservation/reservation-billing";
import { reservationCustomerEmailSchema } from "@/features/reservation/reservation-contact";
import { reservationStatusPath } from "@/features/reservation/routes";
import { currentInstant } from "@/shared/utils/temporal";
import {
  type EntryPackPurchaseQuote,
  entryPackPurchaseQuoteCodec,
} from "../entry-pack-purchase-quote";
import {
  type EntryPackProduct,
  getEntryPackPrice,
  isEntryPackQuoteExpired,
} from "../pass-offer";
import { quoteEntryPack } from "./entry-pack-quote";

export class EntryPackPurchaseError extends Data.TaggedError(
  "EntryPackPurchaseError"
)<{
  readonly reason:
    | "unavailable"
    | "buyer-profile-required"
    | "holder-unavailable"
    | "purchase-conflict"
    | "consent-required"
    | "terms-changed"
    | "quote-expired"
    | "payment-in-progress"
    | "billing-changed";
  readonly locale?: Locale;
}> {}

const decodeBilling = Schema.decodeEffect(reservationBillingSelectionSchema, {
  onExcessProperty: "error",
});
const billingMatches = Schema.toEquivalence(reservationBillingSelectionSchema);

/** The terms of a price the buyer has seen, independent of labels and timers. */
export const getEntryPackPriceFingerprint = (quote: EntryPackPurchaseQuote) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        quote.discountableSubtotal,
        quote.discountedSubtotal,
        quote.discounts.map(({ discount, amount }) => [discount.id, amount]),
        quote.selection?.submittedCode,
        quote.selection?.referralCode,
      ])
    )
    .digest("hex");

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
        const acceptedQuote = yield* Schema.encodeEffect(
          entryPackPurchaseQuoteCodec
        )({
          ...quote,
          selection: {
            ...(input.submittedCode !== undefined && {
              submittedCode: input.submittedCode,
            }),
            ...(input.referralCode !== undefined && {
              referralCode: input.referralCode,
            }),
          },
        });

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

const readOwnedPurchaseOrder = Effect.fn("readOwnedEntryPackPurchaseOrder")(
  function* (orderId: OrderId, buyerAccountId: CustomerAccountId) {
    const { db } = yield* WorkspaceDatabase;
    const [entry] = yield* db
      .select({ order: orders, purchase: passPurchases })
      .from(passPurchases)
      .innerJoin(orders, eq(orders.id, passPurchases.id))
      .where(
        and(
          eq(passPurchases.id, orderId),
          eq(passPurchases.buyerAccountId, buyerAccountId),
          eq(orders.kind, "pass-purchase")
        )
      );
    if (!entry)
      return yield* new EntryPackPurchaseError({ reason: "unavailable" });
    return entry;
  }
);

export const readEntryPackCheckoutDraft = Effect.fn(
  "readEntryPackCheckoutDraft"
)(function* (orderId: OrderId) {
  const current = yield* CurrentCustomerAccount;
  const { accountId } = yield* current.requireActive;
  const { order, purchase } = yield* readOwnedPurchaseOrder(orderId, accountId);
  if (order.paymentState !== "not_started" || order.activePaymentAttemptId) {
    return { kind: "status" as const };
  }
  const now = yield* currentInstant;
  if (isEntryPackQuoteExpired(now, purchase.validUntil)) {
    return { kind: "expired" as const };
  }
  const holderEmail =
    purchase.holderAccountId === accountId
      ? undefined
      : yield* findPurchaseLoginEmail(purchase.holderAccountId);
  if (purchase.holderAccountId !== accountId && !holderEmail) {
    return { kind: "status" as const };
  }
  return {
    kind: "draft" as const,
    locale: purchase.locale,
    product: {
      kind: "entry-pack",
      tier: purchase.tier,
      size: purchase.entryCount,
    } satisfies EntryPackProduct,
    validUntil: purchase.validUntil.toString(),
    holderEmail,
  };
});

const saveEntryPackQuote = Effect.fn("saveEntryPackQuote")(function* (
  orderId: OrderId,
  quote: EntryPackPurchaseQuote
) {
  const { db } = yield* WorkspaceDatabase;
  const encoded = yield* Schema.encodeEffect(entryPackPurchaseQuoteCodec)(
    quote
  );
  yield* db
    .update(passPurchases)
    .set({ quote: encoded })
    .where(eq(passPurchases.id, orderId));
});

/** Reprices an unpaid pack without making a payment attempt. */
export const repriceEntryPackPurchase = Effect.fn("repriceEntryPackPurchase")(
  function* (input: {
    readonly orderId: OrderId;
    readonly displayedPriceFingerprint: string;
    readonly submittedCode?: CanonicalPromotionCode;
    readonly referralCode?: CanonicalPromotionCode;
  }) {
    yield* requirePassPurchasesEnabled();
    const current = yield* CurrentCustomerAccount;
    const session = yield* current.requireActive;
    const accounts = yield* CustomerAccountSections;

    return yield* accounts.withActiveAccount(
      session.accountId,
      Effect.gen(function* () {
        const { order, purchase } = yield* readOwnedPurchaseOrder(
          input.orderId,
          session.accountId
        );
        if (
          order.paymentState !== "not_started" ||
          order.activePaymentAttemptId
        ) {
          return yield* new EntryPackPurchaseError({
            reason: "payment-in-progress",
          });
        }
        const bookedAt = yield* currentInstant;
        if (isEntryPackQuoteExpired(bookedAt, purchase.validUntil)) {
          return yield* new EntryPackPurchaseError({ reason: "quote-expired" });
        }
        const storedQuote = yield* Schema.decodeUnknownEffect(
          entryPackPurchaseQuoteCodec
        )(purchase.quote);
        if (
          input.displayedPriceFingerprint !==
          getEntryPackPriceFingerprint(storedQuote)
        ) {
          return { status: "pricing_changed" as const, quote: storedQuote };
        }

        const discounts = yield* DiscountService;
        const product = {
          kind: "entry-pack",
          tier: purchase.tier,
          size: purchase.entryCount,
        } as const;
        const discountInput = {
          product,
          discountableSubtotal: getEntryPackPrice(product),
          firstServiceDate: purchase.validFrom,
          lastServiceDate: purchase.validFrom,
          bookedAt,
          dotyposCustomerId: order.dotyposCustomerId,
          locale: purchase.locale,
          ...(input.referralCode !== undefined && {
            referralCode: input.referralCode,
          }),
        };
        const baseQuote = yield* discounts.quote(discountInput);
        const quote = input.submittedCode
          ? (yield* discounts.applyDiscountCode({
              ...discountInput,
              baseQuote,
              submittedCode: input.submittedCode,
            })).quote
          : baseQuote;

        const selectedQuote = {
          ...quote,
          selection: {
            ...(input.submittedCode !== undefined && {
              submittedCode: input.submittedCode,
            }),
            ...(input.referralCode !== undefined && {
              referralCode: input.referralCode,
            }),
          },
        };
        yield* saveEntryPackQuote(order.id, selectedQuote);
        return { status: "ready" as const, quote: selectedQuote };
      })
    );
  }
);

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
    return yield* new EntryPackPurchaseError({
      reason: "terms-changed",
      locale: purchase.locale,
    });
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
    readonly billing?: ReservationBillingSelection;
    readonly displayedPriceFingerprint?: string;
  }
) {
  yield* requirePassPurchasesEnabled();
  const current = yield* CurrentCustomerAccount;
  const session = yield* current.requireActive;
  const accounts = yield* CustomerAccountSections;
  const handlers = yield* OrderPaymentHandlers;
  const handler = handlers.byKind["pass-purchase"];
  if (!handler)
    return yield* new EntryPackPurchaseError({ reason: "unavailable" });

  const result = yield* accounts.withActiveAccount(
    session.accountId,
    Effect.gen(function* () {
      const { db } = yield* WorkspaceDatabase;
      const { order, purchase } = yield* readOwnedPurchaseOrder(
        input.orderId,
        session.accountId
      );
      const statusUrl = `/${purchase.locale}${reservationStatusPath}/${order.id}`;
      if (order.paymentState === "paid") {
        return { status: "paid" as const, statusUrl };
      }
      const accepted = yield* Schema.decodeEffect(entryPackPurchaseQuoteCodec)(
        purchase.quote
      );
      const acceptedFingerprint = getEntryPackPriceFingerprint(accepted);
      const stalePrice =
        input.displayedPriceFingerprint !== undefined &&
        input.displayedPriceFingerprint !== acceptedFingerprint;
      if (stalePrice) {
        return order.paymentState === "pending"
          ? { status: "pending" as const, statusUrl }
          : { status: "pricing_changed" as const, quote: accepted };
      }
      const snapshots = yield* AccountingDocumentSnapshots;
      const frozen = order.activePaymentAttemptId
        ? yield* snapshots.findEntryPack(order.activePaymentAttemptId)
        : undefined;
      const billing = yield* decodeBilling(
        input.billing ?? frozen?.billing ?? defaultReservationBillingSelection
      );
      if (
        order.activePaymentAttemptId &&
        (!frozen || !billingMatches(frozen.billing, billing))
      ) {
        return yield* new EntryPackPurchaseError({ reason: "billing-changed" });
      }
      if (order.paymentState === "pending" && order.activePaymentAttemptId) {
        const [attempt] = yield* db
          .select()
          .from(paymentAttempts)
          .where(
            and(
              eq(paymentAttempts.id, order.activePaymentAttemptId),
              eq(paymentAttempts.orderId, order.id)
            )
          );
        if (attempt) {
          const page = getPaymentPageToReopen(attempt, yield* currentInstant);
          if ("providerRedirectUrl" in page) {
            const providerStatus = yield* PaymentPageProviderStatus;
            const observation = yield* providerStatus.observe({
              attempt,
              reservation: order,
            });
            const decision = decidePaymentPageReopening(
              attempt,
              yield* currentInstant,
              observation
            );
            if (decision === "open") {
              return {
                status: "hosted" as const,
                statusUrl,
                redirectUrl: page.providerRedirectUrl,
              };
            }
          }
        }
        return { status: "pending" as const, statusUrl };
      }

      const now = yield* currentInstant;
      if (isEntryPackQuoteExpired(now, purchase.validUntil)) {
        return yield* new EntryPackPurchaseError({
          reason: order.activePaymentAttemptId
            ? "payment-in-progress"
            : "quote-expired",
        });
      }

      const discountService = yield* DiscountService;
      const product = {
        kind: "entry-pack",
        tier: purchase.tier,
        size: purchase.entryCount,
      } as const;
      const selection = accepted.selection ?? {
        ...(input.submittedCode !== undefined && {
          submittedCode: input.submittedCode,
        }),
        ...(input.referralCode !== undefined && {
          referralCode: input.referralCode,
        }),
      };
      const { quote, commitment } =
        yield* discountService.affirmDisplayedDiscounts({
          product,
          discountableSubtotal: getEntryPackPrice(product),
          firstServiceDate: purchase.validFrom,
          lastServiceDate: purchase.validFrom,
          bookedAt: now,
          dotyposCustomerId: order.dotyposCustomerId,
          locale: purchase.locale,
          displayedDiscountIds: accepted.discounts.map(
            ({ discount }) => discount.id
          ),
          ...selection,
        });
      const refreshedQuote = {
        ...quote,
        ...(accepted.selection && { selection }),
      };
      const currentFingerprint = getEntryPackPriceFingerprint(refreshedQuote);
      if (acceptedFingerprint !== currentFingerprint) {
        // An ended attempt may still settle late at its original price.
        if (order.activePaymentAttemptId) {
          return yield* new EntryPackPurchaseError({
            reason: "payment-in-progress",
          });
        }
        yield* saveEntryPackQuote(order.id, refreshedQuote);
        return { status: "pricing_changed" as const, quote: refreshedQuote };
      }

      if (order.activePaymentAttemptId) {
        // A code can be renamed or reassigned without changing its displayed
        // text or price. Use the sources recorded when the first charge started.
        const priorSources = yield* db
          .select({
            namespace: sql<
              string | null
            >`${discountApplications.provenance}->>'providerNamespace'`,
            reference: sql<
              string | null
            >`${discountApplications.provenance}->>'providerReference'`,
          })
          .from(discountApplications)
          .where(
            eq(
              discountApplications.paymentAttemptId,
              order.activePaymentAttemptId
            )
          )
          .orderBy(discountApplications.sequence);
        const { applications } = getDiscountCommitmentPayload(commitment);
        if (
          priorSources.length !== applications.length ||
          priorSources.some((source, index) => {
            const next = applications[index]?.provenance;
            return (
              source.namespace !== next?.providerNamespace ||
              source.reference !== next?.providerReference
            );
          })
        ) {
          return yield* new EntryPackPurchaseError({
            reason: "payment-in-progress",
          });
        }
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
      const buyer = frozen?.buyer ??
        getReservationInvoiceBuyer({
          billing,
          customerName: contact.name,
        }) ?? { kind: "person" as const, legalName: contact.name };
      const admission = {
        orderId: order.id,
        amount: quote.discountedSubtotal,
        locale: purchase.locale,
        details: {
          commitment,
          snapshot: {
            orderId: order.id,
            dotyposCustomerId: order.dotyposCustomerId,
            locale: purchase.locale,
            supplier: workspaceAccountingSupplier,
            buyer,
            billing,
            delivery: frozen?.delivery ?? { email: session.email },
            serviceDate: purchase.validFrom,
            product,
            quote,
          },
        },
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
        return { status: "paid" as const, statusUrl };
      }

      const { hostedPaymentPage, attachedAttempt } = yield* startPaymentSession(
        {
          ...admission,
          kind: "pass-purchase",
          correlationId: order.correlationId,
          customer: { name: contact.name, email: session.email },
          beforeAttempt: recordEntryPackPaymentConsent(input),
        }
      ).pipe(Effect.scoped);
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
  // Fulfillment takes its order section after the account section ends.
  if (result.status === "paid") {
    yield* handler.scheduleFulfillment({ orderId: input.orderId });
  }
  return result;
});
