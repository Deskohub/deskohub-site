import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Context, Data, Effect, Layer } from "effect";
import type {
  CheckoutSummary,
  CheckoutSummaryChangedKeys,
} from "@/features/checkout/checkout-summary";
import type { Locale } from "@/features/i18n";
import {
  ReservationAuthorizationService,
  type ReservationAuthorizationUnavailableError,
} from "@/features/reservation/backend/reservation-authorization.service";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import type { FreshPayState } from "./checkout-pay-url";

/**
 * Why an order's failed, cancelled or expired payment can't be tried again
 * in place. The customer then books again with the saved selection.
 */
export type PaymentRetryRefusalReason =
  | "paid"
  | "payment_in_progress"
  | "late_payment"
  | "superseded"
  | "reservation_cancelled"
  | "reservation_ended"
  | "details_unavailable"
  | "needs_review";

export type PaymentRetryPreparation =
  /**
   * A Pay state for the same order. `retry` asks for the terms again at the
   * accepted price; `pricingChanged` shows the changed price to accept.
   */
  | {
      readonly state: "ready";
      readonly variant: "retry" | "pricingChanged";
      readonly payState: FreshPayState;
      readonly summary: CheckoutSummary;
      readonly changedKeys?: CheckoutSummaryChangedKeys;
    }
  /** The order doesn't exist or the visitor may not see it. */
  | { readonly state: "not_found" }
  | {
      readonly state: "not_retryable";
      readonly reason: PaymentRetryRefusalReason;
    }
  /** The released spot was taken in the meantime. */
  | { readonly state: "spot_unavailable" }
  /** The provider shows the earlier payment may still settle. */
  | { readonly state: "payment_settling" };

export type PaymentRetryInput = {
  readonly orderId: WorkspaceReservationId;
  /** The locale of the page or app asking; the Pay state is issued in it. */
  readonly locale: Locale;
  readonly accessCookie?: string;
};

/** A provider or reservation-system read failed; asking again may succeed. */
export class PaymentRetryUnavailableError extends Data.TaggedError(
  "PaymentRetryUnavailableError"
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

type PaymentRetryError =
  | EffectDrizzleQueryError
  | ReservationAuthorizationUnavailableError
  | PaymentRetryUnavailableError;

export interface ICheckoutPaymentRetryService {
  /**
   * Prepares paying the same order again after its payment failed, was
   * cancelled or expired: keeps or re-acquires the order's hold, rebuilds the
   * order from the records that own its facts, and issues a Pay state at the
   * re-checked price. It never starts a payment; submitting the Pay state
   * does, through the ordinary checkout.
   */
  readonly prepare: (
    input: PaymentRetryInput
  ) => Effect.Effect<PaymentRetryPreparation, PaymentRetryError>;
}

// Placeholder until the implementation lands; the contract above is fixed.
const implementation = Effect.succeed<ICheckoutPaymentRetryService>({
  prepare: () => Effect.die("CheckoutPaymentRetryService not implemented"),
});

export class CheckoutPaymentRetryService extends Context.Service<
  CheckoutPaymentRetryService,
  ICheckoutPaymentRetryService
>()("@deskohub-workspace/checkout/CheckoutPaymentRetryService") {
  static Default = Layer.effect(this, implementation);

  /**
   * The service deciding who may retry a payment through `authorization`,
   * such as one reading the customer API's session.
   */
  static withAuthorization = <E, R>(
    authorization: Layer.Layer<ReservationAuthorizationService, E, R>
  ) => this.Default.pipe(Layer.provide(authorization));

  static Live = this.withAuthorization(ReservationAuthorizationService.Live);
}
