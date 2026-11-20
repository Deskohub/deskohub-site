import "server-only";

import { type DotyposCustomerId, DotyposService } from "@deskohub/dotypos";
import { and, eq, isNull } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { customerAccounts, passPurchases } from "@/db/schema";
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
import { AccountingDocumentSnapshots } from "@/features/accounting/backend/accounting-document-snapshots";
import { AccountingSnapshotKeyService } from "@/features/accounting/backend/accounting-snapshot-key.service";
import { splitCustomerName } from "@/features/checkout/backend/reservation/dotypos-customer-policy";
import type { CanonicalPromotionCode } from "@/features/discounts/contracts";
import { DiscountService } from "@/features/discounts/discount.service";
import { type Locale, m } from "@/features/i18n";
import { getPaymentSubmitLegalDocuments } from "@/features/legal/payment-submit-evidence";
import { isEndedUnpaidPaymentState, type OrderId } from "@/features/order";
import { getCurrentWorkspaceDate } from "@/features/reservation/reservation-date";
import { currentInstant, plainDateStringSchema } from "@/shared/utils/temporal";
import {
  getEntryPackLastUsableDate,
  getUnlimitedPassPrice,
} from "../pass-offer";
import { passPurchaseQuoteCodec } from "../pass-purchase-quote";
import {
  type UnlimitedPassSelection,
  unlimitedPassRequiresEarlyStart,
  unlimitedPassSelectionSchema,
} from "../unlimited-pass";
import { findOwnedPassPurchaseOrder } from "./entry-pack-order";
import {
  displayPassPurchasePrice,
  EntryPackPurchaseError,
  requirePassPurchasesEnabled,
} from "./entry-pack-purchase";
import { withUnlimitedPassCapacity } from "./unlimited-pass-capacity";
import {
  createUnlimitedPassHolds,
  releaseUnlimitedPassDays,
} from "./unlimited-pass-holds";
import {
  readUnlimitedPassSelection,
  recordUnlimitedPassOrder,
  UnlimitedPassAdmissionError,
} from "./unlimited-pass-orders";

type Purchase = typeof passPurchases.$inferSelect;
const sameSelection = Schema.toEquivalence(unlimitedPassSelectionSchema);

const resolveGiftCustomer = Effect.fn("resolveUnlimitedGiftCustomer")(
  function* (input: {
    readonly accountId: CustomerAccountId;
    readonly email: string;
    readonly recipientName?: string;
  }) {
    const { db } = yield* WorkspaceDatabase;
    const [holder] = yield* db
      .select({ customerId: customerAccounts.dotyposCustomerId })
      .from(customerAccounts)
      .where(
        and(
          eq(customerAccounts.id, input.accountId),
          isNull(customerAccounts.deletedAt)
        )
      );
    const unavailable = () =>
      new UnlimitedPassAdmissionError({ reason: "holder-unavailable" });
    if (!holder) return yield* unavailable();
    if (holder.customerId) return holder.customerId;
    const dotypos = yield* DotyposService;
    const lookup = () =>
      dotypos.findCustomer(
        { firstName: "", email: input.email },
        { lookupFields: ["email"] }
      );
    const existing = yield* lookup();
    if (existing._tag === "Matched") return existing.customer.id;
    if (existing._tag !== "NotFound" || !input.recipientName)
      return yield* unavailable();
    const { firstName, lastName = "" } = splitCustomerName(input.recipientName);
    const created = yield* dotypos.createCustomer({
      email: input.email,
      firstName,
      lastName,
      addressLine1: "",
      addressLine2: "",
      city: "",
      zip: "",
      country: "",
      companyName: "",
      companyId: "",
      vatId: "",
    });
    if (created.id) return created.id;
    const reread = yield* lookup();
    if (reread._tag === "Matched") return reread.customer.id;
    return yield* unavailable();
  }
);

export const beginUnlimitedPassPurchase = Effect.fn(
  "beginUnlimitedPassPurchase"
)(function* (input: {
  readonly orderId: OrderId;
  readonly locale: Locale;
  readonly selection: UnlimitedPassSelection;
  readonly holderEmail?: string;
  readonly recipientName?: string;
  readonly buyerProfile?: CustomerProfileSave;
  readonly referralCode?: CanonicalPromotionCode;
  readonly supersedeOrderId?: OrderId;
}) {
  yield* requirePassPurchasesEnabled();
  const current = yield* CurrentCustomerAccount;
  const session = yield* current.requireActive;
  const accounts = yield* CustomerAccountSections;
  const { db, transaction } = yield* WorkspaceDatabase;
  const holderEmail = input.holderEmail?.trim().toLowerCase();
  const giftEmail =
    holderEmail && holderEmail !== session.email.toLowerCase()
      ? holderEmail
      : undefined;

  if (input.supersedeOrderId && input.supersedeOrderId !== input.orderId) {
    const priorOrderId = input.supersedeOrderId;
    yield* accounts.withActiveAccount(
      session.accountId,
      Effect.gen(function* () {
        const prior = yield* findOwnedPassPurchaseOrder(
          priorOrderId,
          session.accountId,
          "unlimited"
        );
        if (
          prior?.order.paymentState !== "not_started" ||
          prior.order.activePaymentAttemptId
        )
          return;
        yield* db
          .update(passPurchases)
          .set({ status: "void" })
          .where(
            and(
              eq(passPurchases.id, priorOrderId),
              eq(passPurchases.status, "pending_payment")
            )
          );
        yield* releaseUnlimitedPassDays(prior.purchase);
      }),
      { passPurchaseOrderId: priorOrderId }
    );
  }

  yield* accounts.withActiveAccount(
    session.accountId,
    Effect.gen(function* () {
      const existing = yield* findOwnedPassPurchaseOrder(
        input.orderId,
        session.accountId,
        "unlimited"
      );
      let purchase: Purchase;
      if (existing) {
        const selection = readUnlimitedPassSelection(existing.purchase);
        const holderId = giftEmail
          ? yield* findPassHolderAccount(giftEmail)
          : session.accountId;
        if (
          existing.purchase.holderAccountId !== holderId ||
          !selection ||
          !sameSelection(selection, input.selection)
        )
          return yield* new UnlimitedPassAdmissionError({
            reason: "purchase-conflict",
          });
        if (existing.order.paymentState !== "not_started") {
          return yield* new EntryPackPurchaseError({
            reason: "payment-in-progress",
          });
        }
        purchase = existing.purchase;
      } else {
        const now = yield* currentInstant;
        const today = getCurrentWorkspaceDate(now);
        const startDate = Temporal.PlainDate.from(input.selection.startDate);
        if (
          Temporal.PlainDate.compare(startDate, today) < 0 ||
          Temporal.PlainDate.compare(startDate, today.add({ months: 6 })) > 0
        ) {
          return yield* new EntryPackPurchaseError({
            reason: "holds-unavailable",
          });
        }
        const contacts = yield* CustomerAccountContactService;
        const standing = yield* current.peek;
        let buyerCustomerId: DotyposCustomerId | undefined;
        if (standing.kind === "linked")
          buyerCustomerId = standing.account.dotyposCustomerId;
        else if (standing.kind === "unlinked" && input.buyerProfile) {
          buyerCustomerId = (yield* contacts.completeProfile(
            session,
            input.buyerProfile
          ))?.dotyposCustomerId;
        } else if (standing.kind === "unavailable")
          return yield* standing.failure;
        if (!buyerCustomerId) {
          return yield* new EntryPackPurchaseError({
            reason: "buyer-profile-required",
          });
        }
        const buyer = {
          accountId: session.accountId,
          customerId: buyerCustomerId,
        };
        const holderAccountId = giftEmail
          ? yield* transaction(ensurePassHolderAccount(giftEmail))
          : session.accountId;
        if (!holderAccountId)
          return yield* new UnlimitedPassAdmissionError({
            reason: "holder-unavailable",
          });
        const holder = giftEmail
          ? {
              accountId: holderAccountId,
              customerId: yield* resolveGiftCustomer({
                accountId: holderAccountId,
                email: giftEmail,
                ...(input.recipientName && {
                  recipientName: input.recipientName,
                }),
              }),
            }
          : buyer;

        const { selection, locale, orderId, referralCode } = input;
        const product = { kind: "unlimited", tier: selection.tier } as const;
        const discounts = yield* DiscountService;
        const quote = yield* discounts.quote({
          product,
          locale,
          bookedAt: now,
          dotyposCustomerId: buyerCustomerId,
          discountableSubtotal: getUnlimitedPassPrice(product),
          firstServiceDate: selection.startDate,
          lastServiceDate: selection.startDate,
          ...(referralCode !== undefined && { referralCode }),
        });
        purchase = yield* withUnlimitedPassCapacity(
          { selection, startDate },
          ({ days }) =>
            transaction(
              recordUnlimitedPassOrder({
                orderId,
                buyer,
                holder,
                locale,
                createdAt: now,
                selection,
                quote: {
                  ...quote,
                  selection: referralCode ? { referralCode } : {},
                  ...(selection.tier === "open-space" &&
                    selection.coffee && { unlimitedCoffee: true }),
                },
                days: days.map((day) => ({
                  ...day,
                  serviceDate: plainDateStringSchema.make(
                    day.serviceDate.toString()
                  ),
                })),
              })
            )
        );
      }

      return purchase;
    })
  );

  return yield* accounts.withActiveAccount(
    session.accountId,
    Effect.gen(function* () {
      const prepared = yield* findOwnedPassPurchaseOrder(
        input.orderId,
        session.accountId,
        "unlimited"
      );
      if (
        prepared?.order.paymentState !== "not_started" ||
        prepared.purchase.status !== "pending_payment"
      ) {
        return yield* new EntryPackPurchaseError({
          reason: "holds-unavailable",
        });
      }
      const { purchase } = prepared;
      yield* createUnlimitedPassHolds(purchase).pipe(
        Effect.catch(
          Effect.fnUntraced(function* (error) {
            yield* db
              .update(passPurchases)
              .set({ status: "void" })
              .where(
                and(
                  eq(passPurchases.id, purchase.id),
                  eq(passPurchases.status, "pending_payment")
                )
              );
            yield* releaseUnlimitedPassDays(purchase).pipe(
              Effect.catch(() =>
                Effect.logWarning(
                  "Unlimited pass hold compensation needs reconciliation"
                )
              )
            );
            return yield* error;
          })
        )
      );
      return purchase;
    }),
    { passPurchaseOrderId: input.orderId }
  );
});

export const readUnlimitedPassBuyerDraft = Effect.fn(
  "readUnlimitedPassBuyerDraft"
)(function* (orderId: OrderId) {
  const account = yield* CurrentCustomerAccount;
  const { accountId } = yield* account.requireActive;
  const order = yield* findOwnedPassPurchaseOrder(
    orderId,
    accountId,
    "unlimited"
  );
  if (!order) return undefined;
  const { purchase } = order;
  const selection = readUnlimitedPassSelection(purchase);
  if (!selection) return undefined;
  return {
    ...order,
    selection,
    holderEmail:
      purchase.holderAccountId === accountId
        ? undefined
        : yield* findPurchaseLoginEmail(purchase.holderAccountId),
  };
});

export const getUnlimitedPassPaymentDisclosure = (
  locale: Locale,
  earlyStartRequired: boolean
) => ({
  documents: getPaymentSubmitLegalDocuments(locale),
  ...(earlyStartRequired && {
    earlyStartRequest: m.unlimitedPassEarlyStartConsent({}, { locale }),
  }),
});

export const loadUnlimitedCheckoutContinuation = Effect.fn(
  "loadUnlimitedCheckoutContinuation"
)(
  function* (orderId: OrderId, retry: boolean) {
    const draft = yield* readUnlimitedPassBuyerDraft(orderId).pipe(
      Effect.catchTag("CustomerAccountAccessError", () => Effect.undefined)
    );
    if (!draft) return undefined;
    const { order, purchase, selection, holderEmail, activeAttempt } = draft;
    const priorPaymentAttemptId = order.activePaymentAttemptId;
    const now = yield* currentInstant;
    const payable =
      purchase.status === "pending_payment" &&
      purchase.holdsExpireAt &&
      Temporal.Instant.compare(now, purchase.holdsExpireAt) < 0;
    const base = { locale: purchase.locale, selection, holderEmail };
    if (!payable) return undefined;
    if (!retry) return order.paymentState === "not_started" ? base : undefined;
    if (
      !priorPaymentAttemptId ||
      !isEndedUnpaidPaymentState(order.paymentState) ||
      !activeAttempt ||
      activeAttempt.refundState !== "not_required" ||
      !isEndedUnpaidPaymentState(activeAttempt.state)
    )
      return undefined;
    const documents = yield* AccountingDocumentSnapshots;
    const snapshot = yield* documents.findPassPurchase(priorPaymentAttemptId);
    if (!snapshot) return undefined;
    const quote = yield* Schema.decodeEffect(passPurchaseQuoteCodec)(
      purchase.quote
    );
    return {
      ...base,
      retryPayment: {
        billing: snapshot.billing,
        price: displayPassPurchasePrice(quote),
        disclosure: getUnlimitedPassPaymentDisclosure(
          purchase.locale,
          unlimitedPassRequiresEarlyStart(
            purchase.validFrom,
            getCurrentWorkspaceDate(now)
          )
        ),
        priorPaymentAttemptId,
        validFrom: purchase.validFrom,
        lastUsableDate: getEntryPackLastUsableDate(
          purchase.validUntil
        ).toString(),
      },
    };
  },
  Effect.provide(
    AccountingDocumentSnapshots.Default.pipe(
      Layer.provide(
        Layer.mergeAll(
          WorkspaceDatabase.Default,
          AccountingSnapshotKeyService.Default
        )
      )
    )
  )
);
