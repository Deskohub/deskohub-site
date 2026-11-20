import "server-only";

import type { EntryPackCheckoutPrice } from "../entry-pack-checkout";
import { getEntryPackPriceFingerprint } from "./entry-pack-purchase";
import type { EntryPackPurchaseQuote } from "./entry-pack-quote";

export const displayEntryPackCheckoutPrice = (
  quote: EntryPackPurchaseQuote
): EntryPackCheckoutPrice => ({
  fingerprint: getEntryPackPriceFingerprint(quote),
  subtotal: quote.discountableSubtotal,
  total: quote.discountedSubtotal,
  submittedCode: quote.selection?.submittedCode,
  discounts: quote.discounts.map(({ discount, amount }) => ({
    id: discount.id,
    label: discount.label,
    amount,
  })),
});
