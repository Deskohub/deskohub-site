import { Effect } from "effect";
import type { CheckoutSummaryChangedKeys } from "@/features/checkout/checkout-summary";
import type { Locale } from "@/features/i18n";
import type { DotyposCustomerId } from "@/features/reservation/dotypos-customer";
import {
  CheckoutPricingService,
  type PaymentPriceAffirmation,
} from "./checkout-pricing.service";
import {
  type BuildSignedPayStateInput,
  getSignedPayStateBookedAt,
  getSignedPayStateSubmittedCode,
  type SignedPayState,
} from "./pay-state.server";
import { getPayStateBindingInput } from "./pay-state-contract";

/**
 * Whether a Pay state's price still holds for payment. `priced` is the price
 * payment continues with; a changed price also carries the review state the
 * customer accepts before paying.
 */
export type PayStatePriceAffirmation =
  | {
      readonly status: "affirmed";
      readonly priced: PaymentPriceAffirmation;
    }
  | {
      readonly status: "pricing_changed";
      readonly priced: PaymentPriceAffirmation;
      readonly changedKeys: CheckoutSummaryChangedKeys;
      /** The Pay state to issue for the customer's review of `priced`. */
      readonly reviewState: BuildSignedPayStateInput;
    };

/**
 * The Pay state that asks the customer to review `priced` instead of the
 * price `state` signed. It keeps the order, its booking instant, its binding
 * (session or order), the referral, the requested code, and the applied code
 * while the new price still applies it.
 */
export const getPriceReviewPayStateInput = (input: {
  readonly state: SignedPayState;
  readonly priced: PaymentPriceAffirmation;
  readonly changedKeys: CheckoutSummaryChangedKeys;
  readonly locale: Locale;
}): BuildSignedPayStateInput => {
  const { state, priced } = input;
  return {
    ...priced,
    locale: input.locale,
    orderId: state.orderId,
    bookedAt: state.bookedAt,
    ...getPayStateBindingInput(state),
    referralCode: state.referralCode,
    requestedDiscountCode: state.requestedDiscountCode ?? state.submittedCode,
    ...getSignedPayStateSubmittedCode(state, priced.quote.payment.discounts),
    changedKeys: input.changedKeys,
  };
};

/**
 * Re-checks the price a Pay state signed against current pricing for the
 * order's stored customer, at the state's booking instant. Order submission
 * pays the affirmed price or returns the review; a payment retry signs its
 * order-bound state at the retry moment and seals the state or the review.
 */
export const affirmPayStatePrice = Effect.fn("checkout.affirmPayStatePrice")(
  function* (input: {
    readonly state: SignedPayState;
    readonly dotyposCustomerId: DotyposCustomerId;
    readonly locale: Locale;
  }) {
    const pricing = yield* CheckoutPricingService;
    const verdict = yield* pricing.affirmForPayment({
      ...input.state,
      bookedAt: getSignedPayStateBookedAt(input.state),
      dotyposCustomerId: input.dotyposCustomerId,
      locale: input.locale,
    });
    if (verdict.status === "affirmed") {
      const affirmed: PayStatePriceAffirmation = verdict;
      return affirmed;
    }
    const changed: PayStatePriceAffirmation = {
      ...verdict,
      reviewState: getPriceReviewPayStateInput({
        state: input.state,
        priced: verdict.priced,
        changedKeys: verdict.changedKeys,
        locale: input.locale,
      }),
    };
    return changed;
  }
);
