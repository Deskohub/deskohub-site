import { Schema } from "effect";
import type { RequireAllOrNone } from "type-fest";
import { checkoutSessionIdSchema } from "@/features/checkout/checkout-identifiers";
import {
  type CheckoutSummaryChangedKeys,
  checkoutSummaryChangedKeysSchema,
} from "@/features/checkout/checkout-summary";
import {
  type CanonicalPromotionCode,
  canonicalPromotionCodeSchema,
  type DiscountId,
  discountIdSchema,
} from "@/features/discounts/contracts";
import type { Locale } from "@/features/i18n";
import { locales } from "@/features/i18n";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import { sealedStateKeyIdSchema } from "@/shared/backend/sealed-state";
import { nonNegativeMoneyCodec } from "@/shared/money/money";
import {
  type Instant,
  instantStringSchema,
  unixTimestampSecondsSchema,
} from "@/shared/utils/temporal";

export const signedPayStateEnvelopeSchema = Schema.Struct({
  kid: sealedStateKeyIdSchema,
  iat: unixTimestampSecondsSchema,
  exp: unixTimestampSecondsSchema,
  locale: Schema.Literals(locales),
  orderId: workspaceReservationIdSchema,
  bookedAt: instantStringSchema,
  checkoutSessionId: Schema.optional(checkoutSessionIdSchema),
  /**
   * `order`: issued for an existing order (a payment retry) and accepted
   * while that order is still the current one of its checkout session,
   * without the session's raw id. Absent: bound to `checkoutSessionId`.
   */
  binding: Schema.optional(Schema.Literal("order")),
  acceptedTotal: nonNegativeMoneyCodec,
  submittedCode: Schema.optional(canonicalPromotionCodeSchema),
  submittedCodeDiscountId: Schema.optional(discountIdSchema),
  requestedDiscountCode: Schema.optional(canonicalPromotionCodeSchema),
  /**
   * Referral code applied for this order. It prices the invitation while it
   * stays eligible, and its attribution is recorded only when the order is
   * paid.
   */
  referralCode: Schema.optional(canonicalPromotionCodeSchema),
  changedKeys: Schema.optional(checkoutSummaryChangedKeysSchema),
});

export type SignedPayStateEnvelope = typeof signedPayStateEnvelopeSchema.Type;

export type BuildSignedPayStateBindingInput = {
  readonly checkoutSessionId?: typeof checkoutSessionIdSchema.Type;
  /**
   * `order` binds the state to `orderId` alone, for a payment retry; it
   * excludes `checkoutSessionId` (building such a state fails).
   */
  readonly binding?: "order";
};

type BuildSignedPayStateBaseInput = BuildSignedPayStateBindingInput & {
  readonly locale: Locale;
  readonly orderId: typeof workspaceReservationIdSchema.Type;
  /** Moment the reservation was submitted; calendar sales are evaluated at it. */
  readonly bookedAt: Instant;
  readonly requestedDiscountCode?: CanonicalPromotionCode;
  readonly referralCode?: CanonicalPromotionCode;
  readonly changedKeys?: CheckoutSummaryChangedKeys;
  readonly ttlMilliseconds?: number;
};

export type PayStateSubmittedCodeMetadata = RequireAllOrNone<{
  readonly submittedCode: CanonicalPromotionCode;
  readonly submittedCodeDiscountId: DiscountId;
}>;

export const getSubmittedCodeMetadata = (input: {
  readonly submittedCode?: CanonicalPromotionCode;
  readonly submittedCodeDiscountId?: DiscountId;
}): PayStateSubmittedCodeMetadata =>
  input.submittedCode !== undefined &&
  input.submittedCodeDiscountId !== undefined
    ? {
        submittedCode: input.submittedCode,
        submittedCodeDiscountId: input.submittedCodeDiscountId,
      }
    : {};

export type BuildSignedPayStateCommonInput = BuildSignedPayStateBaseInput &
  PayStateSubmittedCodeMetadata;

export const buildSignedPayStateEnvelope = (
  envelope: Omit<
    SignedPayStateEnvelope,
    | "acceptedTotal"
    | "checkoutSessionId"
    | "binding"
    | "submittedCode"
    | "submittedCodeDiscountId"
    | "requestedDiscountCode"
    | "referralCode"
    | "changedKeys"
  >,
  input: BuildSignedPayStateCommonInput,
  acceptedTotal: SignedPayStateEnvelope["acceptedTotal"]
): SignedPayStateEnvelope => ({
  ...envelope,
  acceptedTotal,
  ...(input.checkoutSessionId !== undefined && {
    checkoutSessionId: input.checkoutSessionId,
  }),
  ...(input.binding !== undefined && { binding: input.binding }),
  ...(input.submittedCode !== undefined && {
    submittedCode: input.submittedCode,
  }),
  ...(input.submittedCodeDiscountId !== undefined && {
    submittedCodeDiscountId: input.submittedCodeDiscountId,
  }),
  ...(input.requestedDiscountCode !== undefined && {
    requestedDiscountCode: input.requestedDiscountCode,
  }),
  ...(input.referralCode !== undefined && {
    referralCode: input.referralCode,
  }),
  ...(input.changedKeys !== undefined && {
    changedKeys: {
      sectionKeys: [...input.changedKeys.sectionKeys],
      itemKeys: [...input.changedKeys.itemKeys],
    },
  }),
});

export type PayStateBinding =
  | {
      readonly kind: "session";
      readonly checkoutSessionId: typeof checkoutSessionIdSchema.Type;
    }
  | { readonly kind: "order" };

/**
 * The order a Pay state may pay, or `undefined` when it names neither a
 * session nor an order binding (such a state pays nothing).
 */
export const getPayStateBinding = (
  state: Pick<SignedPayStateEnvelope, "binding" | "checkoutSessionId">
): PayStateBinding | undefined => {
  if (state.binding === "order") {
    return state.checkoutSessionId === undefined
      ? { kind: "order" }
      : undefined;
  }
  return state.checkoutSessionId === undefined
    ? undefined
    : { kind: "session", checkoutSessionId: state.checkoutSessionId };
};

/** A Pay state issued to retry the payment of one existing order. */
export const isOrderBoundPayState = (
  state: Pick<SignedPayStateEnvelope, "binding" | "checkoutSessionId">
) => getPayStateBinding(state)?.kind === "order";

/**
 * The binding a state issued from `state` keeps: its checkout session, or
 * its order for a payment retry. Every reissue (price review, discount code,
 * referral) spreads it instead of naming `checkoutSessionId`.
 */
export const getPayStateBindingInput = (
  state: Pick<SignedPayStateEnvelope, "binding" | "checkoutSessionId">
): BuildSignedPayStateBindingInput => ({
  ...(state.checkoutSessionId !== undefined && {
    checkoutSessionId: state.checkoutSessionId,
  }),
  ...(state.binding !== undefined && { binding: state.binding }),
});
