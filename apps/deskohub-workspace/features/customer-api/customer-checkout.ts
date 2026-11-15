import type { CustomerCheckout } from "@deskohub/workspace-customer-api";
import type { PayStateCheckoutView } from "@/features/checkout/backend/checkout/pay-state-checkout-view";

/** What a request changed about the client's remembered referral code. */
export type CustomerCheckoutReferralFacts = Pick<
  CustomerCheckout,
  "referralApplied" | "rememberReferralCode" | "rememberedReferralCodeUsed"
>;

/**
 * A held order's checkout as the customer API carries it, from the view of
 * the Pay state behind `payStateToken`: ready to pay, or showing a changed
 * price to accept first.
 */
export const toCustomerCheckout = (
  view: PayStateCheckoutView,
  payStateToken: string,
  facts: CustomerCheckoutReferralFacts = {}
): CustomerCheckout => ({
  status: view.changedKeys === undefined ? "ready" : "price_review",
  orderId: view.orderId,
  payStateToken,
  expiresAt: view.expiresAt,
  summary: view.summary,
  ...(view.changedKeys !== undefined && {
    priceReview: { changedKeys: view.changedKeys },
  }),
  earlyPerformanceConsent: view.earlyPerformanceConsent,
  ...(facts.referralApplied && { referralApplied: true }),
  ...(facts.rememberReferralCode !== undefined && {
    rememberReferralCode: facts.rememberReferralCode,
  }),
  ...(facts.rememberedReferralCodeUsed && {
    rememberedReferralCodeUsed: true,
  }),
});
