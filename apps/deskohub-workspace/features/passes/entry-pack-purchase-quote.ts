import { Schema } from "effect";
import {
  canonicalPromotionCodeSchema,
  discountIdSchema,
  discountQuoteCodec,
} from "@/features/discounts/contracts";

const entryPackQuoteSelectionSchema = Schema.Struct({
  submittedCode: Schema.optionalKey(canonicalPromotionCodeSchema),
  referralCode: Schema.optionalKey(canonicalPromotionCodeSchema),
});

/** The buyer's private pricing inputs and the applied code's discount ID. */
export const entryPackPurchaseQuoteCodec = Schema.Struct({
  ...discountQuoteCodec.fields,
  selection: Schema.optionalKey(entryPackQuoteSelectionSchema),
  submittedCodeDiscountId: Schema.optionalKey(discountIdSchema),
});

export type EntryPackPurchaseQuote = typeof entryPackPurchaseQuoteCodec.Type;
