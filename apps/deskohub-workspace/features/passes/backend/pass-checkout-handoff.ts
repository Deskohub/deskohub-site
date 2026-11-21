import "server-only";

import { Effect, Schema } from "effect";
import { CurrentCustomerAccount } from "@/features/account/backend/current-customer-account";
import { customerAccountIdSchema } from "@/features/account/customer-account";
import type { Locale } from "@/features/i18n";
import { orderIdSchema } from "@/features/order";
import { reservationCustomerEmailSchema } from "@/features/reservation/reservation-contact";
import { makeSealedState } from "@/shared/backend/sealed-state";
import { entryPackProductSchema } from "../pass-offer";
import { entryPackCheckoutPath, unlimitedPassCheckoutPath } from "../routes";
import { unlimitedPassSelectionSchema } from "../unlimited-pass";

const productSchema = Schema.Union([
  entryPackProductSchema,
  Schema.Struct({
    kind: Schema.Literal("unlimited"),
    selection: unlimitedPassSelectionSchema,
  }),
]);

export type PassPurchaseProduct = typeof productSchema.Type;

const maxTokenLength = 1024;
export const passCheckoutHandoffTokenSchema = Schema.NonEmptyString.check(
  Schema.isMaxLength(maxTokenLength)
);

const checkoutHandoff = makeSealedState({
  purpose: "pass-checkout-details",
  ttlMilliseconds: 30 * 60 * 1000,
  maxTokenLength,
  schema: Schema.Struct({
    buyerAccountId: customerAccountIdSchema,
    orderId: orderIdSchema,
    product: productSchema,
    holderEmail: Schema.optionalKey(reservationCustomerEmailSchema),
  }),
});

export const getPassCheckoutHandoffPath = (
  locale: Locale,
  kind: PassPurchaseProduct["kind"],
  token: string
) => {
  const path =
    kind === "entry-pack" ? entryPackCheckoutPath : unlimitedPassCheckoutPath;
  return `/${locale}${path}?${new URLSearchParams({ step: "details", handoff: token })}`;
};

export const sealPassCheckoutHandoff = checkoutHandoff.seal;

export const readPassCheckoutHandoff = Effect.fn("passes.readCheckoutHandoff")(
  function* (token: string) {
    const actor = yield* CurrentCustomerAccount;
    const { accountId } = yield* actor.requireActive;
    const handoff = yield* checkoutHandoff
      .open(token)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (handoff?.buyerAccountId !== accountId) return undefined;
    return handoff;
  }
);
