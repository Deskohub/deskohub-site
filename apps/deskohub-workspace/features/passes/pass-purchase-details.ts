import { Schema } from "effect";
import { updateCustomerProfileSchema } from "@/features/account/contracts";
import type { Locale } from "@/features/i18n";
import { reservationBillingSelectionSchema } from "@/features/reservation/reservation-billing";
import { reservationCustomerEmailSchema } from "@/features/reservation/reservation-contact";

export type PassPurchaseBuyer =
  | { readonly kind: "signed-out" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "profile-required"; readonly email: string }
  | { readonly kind: "linked"; readonly name: string; readonly email: string };

export const passPurchaseDetailsSchema = (locale: Locale) =>
  Schema.Struct({
    holderEmail: Schema.optionalKey(reservationCustomerEmailSchema),
    buyerProfile: Schema.optionalKey(updateCustomerProfileSchema(locale)),
    billing: reservationBillingSelectionSchema,
  });
