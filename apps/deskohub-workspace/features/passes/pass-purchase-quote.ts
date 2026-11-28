import type { passPurchaseQuoteCodec } from "@deskohub/workspace-domain/features/passes/pass-purchase-quote";

export { passPurchaseQuoteCodec } from "@deskohub/workspace-domain/features/passes/pass-purchase-quote";

import { type Money, moneyWithValue } from "@/shared/money/money";
import { unlimitedPassCoffeePrice } from "./pass-offer";

export type PassPurchaseQuote = typeof passPurchaseQuoteCodec.Type;

export const catalogCoffeeAmountMinor = (unlimitedCoffee?: boolean | null) =>
  unlimitedCoffee ? unlimitedPassCoffeePrice.value : null;

/** Coffee is priced in the same currency and minor units as the pass. */
export const withPassPurchaseCoffee = (
  base: Money,
  coffeeAmountMinor?: number | null
) => moneyWithValue(base.value + (coffeeAmountMinor ?? 0), base);
