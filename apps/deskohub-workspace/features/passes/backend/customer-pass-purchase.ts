import "server-only";

import { Effect, Schema } from "effect";
import { CurrentCustomerAccount } from "@/features/account/backend/current-customer-account";
import type { CustomerAccountSession } from "@/features/account/backend/customer-authentication.service";
import type { CustomerProfileSave } from "@/features/account/contracts";
import type { CanonicalPromotionCode } from "@/features/discounts/contracts";
import type { Locale } from "@/features/i18n";
import type { OrderId } from "@/features/order";
import { findOrderKind } from "@/features/order/backend/order-kind";
import { reservationCustomerEmailSchema } from "@/features/reservation/reservation-contact";
import { getCurrentWorkspaceDate } from "@/features/reservation/reservation-date";
import { reservationStatusPath } from "@/features/reservation/routes";
import { currentInstant, type PlainDate } from "@/shared/utils/temporal";
import {
  getEntryPackDetailsPath,
  getEntryPackPayPath,
} from "../entry-pack-checkout";
import {
  type EntryPackProduct,
  getEntryPackLastUsableDate,
} from "../pass-offer";
import { unlimitedGiftRecipientNameSchema } from "../pass-purchase-details";
import { passPurchaseQuoteCodec } from "../pass-purchase-quote";
import {
  type UnlimitedPassSelection,
  unlimitedPassRequiresEarlyStart,
} from "../unlimited-pass";
import {
  getUnlimitedPassDetailsPath,
  getUnlimitedPassPayPath,
} from "../unlimited-pass-checkout";
import { findOwnedPassPurchaseOrder } from "./entry-pack-order";
import {
  beginEntryPackPurchase,
  displayPassPurchasePrice,
  EntryPackPurchaseError,
  getEntryPackPaymentDisclosure,
  payForEntryPack,
  requirePassPurchasesEnabled,
} from "./entry-pack-purchase";
import { loadEntryPackStatus } from "./entry-pack-status";
import {
  beginUnlimitedPassPurchase,
  getUnlimitedPassPaymentDisclosure,
} from "./unlimited-pass-purchase";
import { readUnlimitedPassStartDates } from "./unlimited-pass-start-dates";

export type PassPurchaseProduct =
  | EntryPackProduct
  | { readonly kind: "unlimited"; readonly selection: UnlimitedPassSelection };

export type BeginPassPurchaseInput = {
  readonly orderId: OrderId;
  readonly locale: Locale;
  readonly product: PassPurchaseProduct;
  readonly holderEmail?: string;
  readonly recipientName?: string;
  readonly buyerProfile?: CustomerProfileSave;
  readonly referralCode?: CanonicalPromotionCode;
  readonly supersedeOrderId?: OrderId;
};

const readPaymentDisclosure = Effect.fn("passes.readPaymentDisclosure")(
  function* (
    product: PassPurchaseProduct["kind"],
    locale: Locale,
    validFrom: PlainDate
  ) {
    if (product === "entry-pack") return getEntryPackPaymentDisclosure(locale);
    return getUnlimitedPassPaymentDisclosure(
      locale,
      unlimitedPassRequiresEarlyStart(
        validFrom,
        getCurrentWorkspaceDate(yield* currentInstant)
      )
    );
  }
);

const beginUnlimitedOrder = Effect.fn("passes.beginUnlimitedOrder")(function* (
  input: BeginPassPurchaseInput,
  selection: UnlimitedPassSelection,
  { accountId, email }: CustomerAccountSession
) {
  const { orderId, supersedeOrderId } = input;
  if (
    supersedeOrderId &&
    supersedeOrderId.toLowerCase() !== orderId.toLowerCase() &&
    !(yield* findOwnedPassPurchaseOrder(
      supersedeOrderId,
      accountId,
      "unlimited"
    ))
  ) {
    return yield* new EntryPackPurchaseError({ reason: "purchase-conflict" });
  }
  const holderEmail =
    input.holderEmail === undefined
      ? undefined
      : yield* Schema.decodeEffect(reservationCustomerEmailSchema)(
          input.holderEmail
        );
  const gift = holderEmail && holderEmail.toLowerCase() !== email.toLowerCase();
  const recipientName =
    input.recipientName === undefined
      ? undefined
      : yield* Schema.decodeEffect(
          unlimitedGiftRecipientNameSchema(input.locale)
        )(input.recipientName);
  if (gift && recipientName === undefined) {
    return yield* new EntryPackPurchaseError({ reason: "holder-unavailable" });
  }
  const { outcome } = yield* beginUnlimitedPassPurchase({
    ...input,
    selection,
    ...(holderEmail !== undefined && { holderEmail }),
    ...(recipientName !== undefined && { recipientName }),
  });
  return yield* Effect.fromResult(outcome);
});

const beginPassOrder = Effect.fn("passes.beginPassOrder")(function* (
  input: BeginPassPurchaseInput
) {
  yield* requirePassPurchasesEnabled();
  const actor = yield* CurrentCustomerAccount;
  const session = yield* actor.requireActive;
  const { product, orderId } = input;
  const existingKind = yield* findOrderKind(orderId);
  if (
    existingKind &&
    (existingKind !== "pass-purchase" ||
      !(yield* findOwnedPassPurchaseOrder(
        orderId,
        session.accountId,
        product.kind
      )))
  ) {
    return yield* new EntryPackPurchaseError({ reason: "purchase-conflict" });
  }
  if (product.kind === "unlimited") {
    return yield* beginUnlimitedOrder(input, product.selection, session);
  }
  if (input.supersedeOrderId) {
    return yield* new EntryPackPurchaseError({ reason: "purchase-conflict" });
  }
  return yield* beginEntryPackPurchase({ ...input, product });
});

const getPassCheckoutPath = (
  locale: Locale,
  product: PassPurchaseProduct,
  orderId?: OrderId
) => {
  if (product.kind === "entry-pack") {
    return orderId
      ? getEntryPackPayPath(locale, orderId)
      : getEntryPackDetailsPath(locale, product);
  }
  return orderId
    ? getUnlimitedPassPayPath(locale, orderId)
    : getUnlimitedPassDetailsPath(locale, product.selection);
};

/** Creates a payable draft and projects what the buyer needs to approve it. */
export const beginPurchase = Effect.fn("passes.beginPurchase")(
  (input: BeginPassPurchaseInput) =>
    Effect.succeed(input).pipe(
      Effect.bind("purchase", beginPassOrder),
      Effect.bind("quote", ({ purchase }) =>
        Schema.decodeEffect(passPurchaseQuoteCodec)(purchase.quote)
      ),
      Effect.bind("disclosure", ({ purchase, product }) =>
        readPaymentDisclosure(product.kind, purchase.locale, purchase.validFrom)
      ),
      Effect.map(({ product, purchase, quote, disclosure }) => ({
        orderId: purchase.id,
        product,
        payPath: getPassCheckoutPath(purchase.locale, product, purchase.id),
        statusPath: `/${purchase.locale}${reservationStatusPath}/${purchase.id}`,
        price: displayPassPurchasePrice(quote),
        validFrom: purchase.validFrom,
        lastUsableDate: getEntryPackLastUsableDate(
          purchase.validUntil
        ).toString(),
        disclosure,
      }))
    )
);

/** Starts a website checkout from a signed-in customer channel. */
export const startPurchase = Effect.fn("passes.startPurchase")(
  (input: BeginPassPurchaseInput) =>
    beginPurchase(input).pipe(
      Effect.map(({ orderId, payPath, statusPath }) => ({
        status: "ready" as const,
        orderId,
        checkoutPath: payPath,
        statusPath,
      })),
      Effect.catchTag("EntryPackPurchaseError", (error) =>
        error.reason === "buyer-profile-required" ||
        error.reason === "holder-unavailable"
          ? Effect.succeed({
              status: "details_required" as const,
              checkoutPath: getPassCheckoutPath(input.locale, input.product),
            })
          : Effect.fail(error)
      )
    )
);

export const purchaseStartDates = Effect.fn("passes.purchaseStartDates")(
  function* (input: {
    readonly startsOn?: PlainDate;
    readonly supersedeOrderId?: OrderId;
  }) {
    yield* requirePassPurchasesEnabled();
    const actor = yield* CurrentCustomerAccount;
    const { accountId } = yield* actor.requireActive;
    return yield* readUnlimitedPassStartDates({
      ...input,
      buyerAccountId: accountId,
      ...(input.supersedeOrderId && {
        predecessorOrderIds: [input.supersedeOrderId],
      }),
    });
  }
);

export type PayPassPurchaseInput = Parameters<typeof payForEntryPack>[0] & {
  readonly productKind: PassPurchaseProduct["kind"];
  readonly displayedPriceFingerprint: string;
};

export const payPurchase = Effect.fn("passes.payPurchase")(
  (input: PayPassPurchaseInput) =>
    payForEntryPack(input).pipe(
      Effect.map((result) =>
        result.status === "pricing_changed"
          ? {
              status: result.status,
              price: displayPassPurchasePrice(result.quote),
            }
          : result
      ),
      Effect.catchTag("EntryPackPurchaseError", (error) =>
        error.reason === "terms-changed" && error.locale
          ? Effect.succeed({
              status: "terms_changed" as const,
              disclosure:
                input.productKind === "entry-pack"
                  ? getEntryPackPaymentDisclosure(error.locale)
                  : getUnlimitedPassPaymentDisclosure(
                      error.locale,
                      error.earlyStartRequired ?? false
                    ),
            })
          : Effect.fail(error)
      )
    )
);

export const purchaseStatus = Effect.fn("passes.purchaseStatus")(function* (
  orderId: OrderId
) {
  yield* requirePassPurchasesEnabled();
  const result = yield* loadEntryPackStatus(orderId, "buyer");
  if (result.status === "paid" && result.gift) {
    const { maskedHolderEmail: _, ...status } = result;
    return status;
  }
  if (!("priorPaymentAttemptId" in result) || !result.priorPaymentAttemptId) {
    return result;
  }
  const actor = yield* CurrentCustomerAccount;
  const { accountId } = yield* actor.requireActive;
  const product = result.entryCount === null ? "unlimited" : "entry-pack";
  const current = yield* findOwnedPassPurchaseOrder(
    orderId,
    accountId,
    product
  );
  if (current?.order.activePaymentAttemptId !== result.priorPaymentAttemptId) {
    return {
      orderId,
      tier: result.tier,
      entryCount: result.entryCount,
      status: "checking" as const,
    };
  }
  const { purchase } = current;
  const quote = yield* Schema.decodeEffect(passPurchaseQuoteCodec)(
    purchase.quote
  );
  return {
    ...result,
    price: displayPassPurchasePrice(quote),
    disclosure: yield* readPaymentDisclosure(
      product,
      purchase.locale,
      purchase.validFrom
    ),
  };
});
