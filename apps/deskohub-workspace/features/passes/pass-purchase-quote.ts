import type { passPurchaseQuoteCodec } from "@deskohub/workspace-domain/features/passes/pass-purchase-quote";

export { passPurchaseQuoteCodec } from "@deskohub/workspace-domain/features/passes/pass-purchase-quote";

import { type Money, moneyWithValue } from "@/shared/money/money";
import { unlimitedPassCoffeePrice } from "./pass-offer";

export type PassPurchaseQuote = typeof passPurchaseQuoteCodec.Type;

/** Coffee is a separate add-on and does not contribute to the discountable base. */
export function withPassPurchaseAddons(
  base: Money,
  unlimitedCoffee?: boolean | null
): Money {
  return unlimitedCoffee
    ? moneyWithValue(base.value + unlimitedPassCoffeePrice.value, base)
    : base;
}
