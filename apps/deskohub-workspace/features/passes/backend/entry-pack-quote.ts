import { createHash } from "node:crypto";
import { Effect } from "effect";
import type { CanonicalPromotionCode } from "@/features/discounts/contracts";
import { DiscountService } from "@/features/discounts/discount.service";
import type { Locale } from "@/features/i18n";
import type { DotyposCustomerId } from "@/features/reservation/dotypos-customer";
import {
  type EntryPackProduct,
  getEntryPackPrice,
  getEntryPackValidity,
} from "../pass-offer";
import {
  catalogCoffeeAmountMinor,
  type PassPurchaseQuote,
} from "../pass-purchase-quote";

/** The terms of a price the buyer has seen, independent of labels and timers. */
export const getPassPurchasePriceFingerprint = (
  quote: PassPurchaseQuote,
  coffeeAmountMinor = catalogCoffeeAmountMinor(quote.unlimitedCoffee)
) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        quote.discountableSubtotal,
        quote.discountedSubtotal,
        quote.discounts.map(({ discount, amount }) => [discount.id, amount]),
        quote.selection?.submittedCode,
        quote.selection?.referralCode,
        ...(coffeeAmountMinor === null ? [] : [coffeeAmountMinor]),
      ])
    )
    .digest("hex");

export const quoteEntryPack = Effect.fn("quoteEntryPack")(function* (input: {
  readonly product: EntryPackProduct;
  readonly buyer: DotyposCustomerId;
  readonly purchasedAt: Temporal.Instant;
  readonly locale: Locale;
  readonly submittedCode?: CanonicalPromotionCode;
  readonly referralCode?: CanonicalPromotionCode;
}) {
  const { validFrom, validUntil } = getEntryPackValidity(
    input.purchasedAt,
    input.product.size
  );
  const discounts = yield* DiscountService;
  const quote = yield* discounts.quote({
    product: input.product,
    discountableSubtotal: getEntryPackPrice(input.product),
    firstServiceDate: validFrom,
    lastServiceDate: validFrom,
    bookedAt: input.purchasedAt,
    locale: input.locale,
    dotyposCustomerId: input.buyer,
    ...(input.submittedCode !== undefined && {
      submittedCode: input.submittedCode,
    }),
    ...(input.referralCode !== undefined && {
      referralCode: input.referralCode,
    }),
  });
  return { quote, validFrom, validUntil };
});
