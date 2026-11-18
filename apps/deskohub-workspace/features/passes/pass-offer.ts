import { Schema } from "effect";
import { currencyCZK } from "@/shared/money/currencies";
import { workspaceSiteConstants } from "@/shared/utils";
import {
  plainDateStringSchema,
  temporalInstantToPlainDate,
} from "@/shared/utils/temporal";

export const passTiers = [
  "open-space",
  "reserved-desk",
  "reserved-desk-workstation",
] as const;
export const passTierSchema = Schema.Literals(passTiers);
export type PassTier = typeof passTierSchema.Type;

export const entryPackSizes = [5, 10] as const;
export const entryPackSizeSchema = Schema.Literals(entryPackSizes);
export type EntryPackSize = typeof entryPackSizeSchema.Type;

export const entryPackProductSchema = Schema.Struct({
  kind: Schema.Literal("entry-pack"),
  tier: passTierSchema,
  size: entryPackSizeSchema,
});
export type EntryPackProduct = typeof entryPackProductSchema.Type;

export const unlimitedPassProductSchema = Schema.Struct({
  kind: Schema.Literal("unlimited"),
  tier: passTierSchema,
});
export type UnlimitedPassProduct = typeof unlimitedPassProductSchema.Type;

export const entryPackProductKeySchema = Schema.TemplateLiteral([
  "entry-pack:",
  passTierSchema,
  ":",
  entryPackSizeSchema,
]);
export const unlimitedPassProductKeySchema = Schema.TemplateLiteral([
  "unlimited:",
  passTierSchema,
]);

type PassProduct = EntryPackProduct | UnlimitedPassProduct;

export const getPassProductKey = (product: PassProduct) =>
  product.kind === "entry-pack"
    ? entryPackProductKeySchema.make(
        `entry-pack:${product.tier}:${product.size}`
      )
    : unlimitedPassProductKeySchema.make(`unlimited:${product.tier}`);

const entryPackPrices = {
  "open-space": { 5: 1150, 10: 2190 },
  "reserved-desk": { 5: 1590, 10: 3090 },
  "reserved-desk-workstation": { 5: 2050, 10: 3990 },
} as const;
const entryPackMonths = { 5: 2, 10: 3 } as const;
const unlimitedPassPrices = {
  "open-space": 3490,
  "reserved-desk": 5990,
  "reserved-desk-workstation": 8490,
} as const;

export const getEntryPackPrice = ({ tier, size }: EntryPackProduct) =>
  currencyCZK(entryPackPrices[tier][size] * 100);

export const entryPackOffers = passTiers.flatMap((tier) =>
  entryPackSizes.map((size) => ({
    product: entryPackProductSchema.make({ kind: "entry-pack", tier, size }),
    price: getEntryPackPrice({ kind: "entry-pack", tier, size }),
    validityMonths: entryPackMonths[size],
  }))
);

export const unlimitedPassOffers = passTiers.map((tier) => ({
  product: unlimitedPassProductSchema.make({ kind: "unlimited", tier }),
  price: currencyCZK(unlimitedPassPrices[tier] * 100),
  validityDays: 30,
}));

export const getEntryPackValidity = (
  purchasedAt: Temporal.Instant,
  size: EntryPackSize
) => {
  const date = temporalInstantToPlainDate({
    instant: purchasedAt,
    timeZone: workspaceSiteConstants.location.timeZone,
  });
  return {
    validFrom: plainDateStringSchema.make(date.toString()),
    validUntil: plainDateStringSchema.make(
      date.add({ months: entryPackMonths[size] }).toString()
    ),
  };
};
