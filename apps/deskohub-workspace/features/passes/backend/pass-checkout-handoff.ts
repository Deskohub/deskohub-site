import "server-only";

import { Effect, Schema } from "effect";
import { CurrentCustomerAccount } from "@/features/account/backend/current-customer-account";
import { customerAccountIdSchema } from "@/features/account/customer-account";
import { canonicalPromotionCodeSchema } from "@/features/discounts/contracts";
import { orderIdSchema } from "@/features/order";
import { reservationCustomerEmailSchema } from "@/features/reservation/reservation-contact";
import { makeSealedState } from "@/shared/backend/sealed-state";
import { passCheckoutHandoffTokenMaxLength } from "../entry-pack-checkout";
import { entryPackProductSchema } from "../pass-offer";
import { getPassPurchaseStatusPath } from "../routes";
import { unlimitedPassSelectionSchema } from "../unlimited-pass";
import {
  findOwnedPassPurchaseOrder,
  hasPassPurchasePaymentStarted,
} from "./entry-pack-order";

const productSchema = Schema.Union([
  entryPackProductSchema,
  Schema.Struct({
    kind: Schema.Literal("unlimited"),
    selection: unlimitedPassSelectionSchema,
  }),
]);

export type PassPurchaseProduct = typeof productSchema.Type;

const checkoutHandoff = makeSealedState({
  purpose: "pass-checkout-details",
  ttlMilliseconds: 30 * 60 * 1000,
  maxTokenLength: passCheckoutHandoffTokenMaxLength,
  schema: Schema.Struct({
    buyerAccountId: customerAccountIdSchema,
    orderId: orderIdSchema,
    product: productSchema,
    holderEmail: Schema.optionalKey(reservationCustomerEmailSchema),
    referralCode: Schema.optionalKey(canonicalPromotionCodeSchema),
    supersedeOrderId: Schema.optionalKey(orderIdSchema),
  }),
});

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

export const readPassCheckoutHandoffForPage = Effect.fn(
  "passes.readCheckoutHandoffForPage"
)(function* (token: string, productKind: PassPurchaseProduct["kind"]) {
  const handoff = yield* readPassCheckoutHandoff(token);
  if (handoff?.product.kind !== productKind) return undefined;
  const owned = yield* findOwnedPassPurchaseOrder(
    handoff.orderId,
    handoff.buyerAccountId,
    productKind
  );
  const statusPath =
    owned && hasPassPurchasePaymentStarted(owned.order)
      ? getPassPurchaseStatusPath(owned.purchase.locale, owned.order.id)
      : undefined;
  return { ...handoff, statusPath };
});
