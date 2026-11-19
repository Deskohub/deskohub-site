import { Schema } from "effect";
import {
  canonicalPromotionCodeSchema,
  discountQuoteCodec,
} from "@/features/discounts/contracts";

const entryPackQuoteSelectionSchema = Schema.Struct({
  submittedCode: Schema.optionalKey(canonicalPromotionCodeSchema),
  referralCode: Schema.optionalKey(canonicalPromotionCodeSchema),
});

/** The buyer's private pricing inputs, kept with the order's quote. */
export const entryPackPurchaseQuoteCodec = Schema.Struct({
  ...discountQuoteCodec.fields,
  selection: Schema.optionalKey(entryPackQuoteSelectionSchema),
});

export type EntryPackPurchaseQuote = typeof entryPackPurchaseQuoteCodec.Type;
