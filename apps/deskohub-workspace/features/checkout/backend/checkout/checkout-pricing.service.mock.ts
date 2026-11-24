import { Effect, Layer, Match } from "effect";
import type { CheckoutSummary } from "@/features/checkout/checkout-summary";
import {
  type AdvertisementAffirmation,
  CheckoutPricingService,
  type CustomerQuoteInput,
  type ICheckoutPricingService,
  type PaymentPriceAffirmation,
  type PaymentRepricingInput,
  type PreparedCustomerQuote,
  reviewDisplayedOfficePrice,
} from "./checkout-pricing.service";
import { PayState } from "./pay-state";
import type { PriceVerdict } from "./price-verdict";
import {
  getCustomerQuotePriceVerdict,
  getPaymentPriceVerdict,
  type ReservationPaymentPriceAffirmation,
} from "./reservation-checkout-pricing";

export const CheckoutPricingServiceMock = Layer.mock(CheckoutPricingService);

/** The error a pricing operation fails with. */
type PricingError = Effect.Error<
  ReturnType<ICheckoutPricingService["repriceForPayment"]>
>;

/** The re-priced quote and commitment a caller's test stub returns. */
export type RepricedPayment<
  Input extends PaymentRepricingInput = PaymentRepricingInput,
> = {
  readonly quote: Input["quote"];
  readonly commitment: PaymentPriceAffirmation["commitment"];
};

/** One family's re-priced payment with the summary its quote shows. */
const pricedPayment = <
  Reservation extends PaymentRepricingInput["reservation"],
  Quote extends PaymentRepricingInput["quote"],
>(
  reservation: Reservation,
  { quote, commitment }: { readonly quote: Quote } & RepricedPayment,
  summary: CheckoutSummary
): ReservationPaymentPriceAffirmation<Reservation, Quote> => ({
  kind: reservation.kind,
  reservation,
  quote,
  commitment,
  summary,
});

/**
 * Payment pricing for a caller's test: `reprice` stands in for the discount
 * affirmation and returns the re-priced quote and commitment, and the
 * payment verdict comes from the real payment rule.
 */
export const paymentPricingFrom = (
  reprice: <Input extends PaymentRepricingInput>(
    input: Input
  ) => Effect.Effect<RepricedPayment<Input>, PricingError>
): Pick<ICheckoutPricingService, "repriceForPayment" | "affirmForPayment"> => {
  const repriceForPayment = (
    input: PaymentRepricingInput
  ): Effect.Effect<PaymentPriceAffirmation, PricingError> =>
    Match.value(input).pipe(
      Match.when({ reservation: { kind: "cowork" } }, (cowork) =>
        reprice(cowork).pipe(
          Effect.map((repriced) =>
            pricedPayment(
              cowork.reservation,
              repriced,
              PayState.summary({
                reservation: cowork.reservation,
                quote: repriced.quote,
              })
            )
          )
        )
      ),
      Match.when({ reservation: { kind: "meeting-room" } }, (meetingRoom) =>
        reprice(meetingRoom).pipe(
          Effect.map((repriced) =>
            pricedPayment(
              meetingRoom.reservation,
              repriced,
              PayState.summary({
                reservation: meetingRoom.reservation,
                quote: repriced.quote,
              })
            )
          )
        )
      ),
      Match.when({ reservation: { kind: "office" } }, (office) =>
        reprice(office).pipe(
          Effect.map((repriced) =>
            pricedPayment(
              office.reservation,
              repriced,
              PayState.summary({
                reservation: office.reservation,
                quote: repriced.quote,
              })
            )
          )
        )
      ),
      Match.exhaustive
    );
  return {
    repriceForPayment,
    affirmForPayment: (input) =>
      repriceForPayment(input).pipe(
        Effect.map((priced) =>
          getPaymentPriceVerdict({
            signed: {
              quote: input.quote,
              summary: PayState.summary(input),
              acceptedTotal: input.acceptedTotal,
            },
            priced,
          })
        )
      ),
  };
};

/** A customer quote input whose advertisement is one family's. */
export type FamilyCustomerQuoteInput<
  Priced extends AdvertisementAffirmation = AdvertisementAffirmation,
> = CustomerQuoteInput & { readonly advertisement: PriceVerdict<Priced> };

/**
 * The verdict on one family's customer quote: full validation keeps the
 * advertised query code, and the verdict comes from the real submission rule.
 */
const customerQuoteVerdict = (input: {
  readonly quoted: CustomerQuoteInput;
  readonly advertisedSummary: CheckoutSummary;
  readonly priced: PreparedCustomerQuote;
  readonly customerSummary: CheckoutSummary;
}) =>
  reviewDisplayedOfficePrice(
    getCustomerQuotePriceVerdict({
      advertised: {
        status: input.quoted.advertisement.status,
        summary: input.advertisedSummary,
      },
      customer: {
        priced: input.priced,
        summary: input.customerSummary,
        advertisedCodeChanged: false,
      },
    }),
    input.quoted.displayedOfficePrice
  );

/**
 * Customer quoting for a caller's test: `quote` stands in for the customer's
 * discounts and returns the customer quote, full validation keeps the
 * advertised query code, and the verdict comes from the real submission rule.
 */
export const customerQuotePricingFrom = (
  quote: <Priced extends AdvertisementAffirmation>(
    input: FamilyCustomerQuoteInput<Priced>
  ) => Effect.Effect<Priced["advertisedQuote"], PricingError>
): Pick<ICheckoutPricingService, "quoteForCustomer"> => ({
  quoteForCustomer: (input) =>
    Match.value(input.advertisement.priced).pipe(
      Match.discriminatorsExhaustive("kind")({
        cowork: (priced) =>
          quote({
            ...input,
            advertisement: { ...input.advertisement, priced },
          }).pipe(
            Effect.map((customerQuote) =>
              customerQuoteVerdict({
                quoted: input,
                advertisedSummary: PayState.summary({
                  reservation: priced.reservation,
                  quote: priced.advertisedQuote,
                }),
                priced: {
                  kind: priced.kind,
                  reservation: priced.reservation,
                  quote: customerQuote,
                },
                customerSummary: PayState.summary({
                  reservation: priced.reservation,
                  quote: customerQuote,
                }),
              })
            )
          ),
        "meeting-room": (priced) =>
          quote({
            ...input,
            advertisement: { ...input.advertisement, priced },
          }).pipe(
            Effect.map((customerQuote) =>
              customerQuoteVerdict({
                quoted: input,
                advertisedSummary: PayState.summary({
                  reservation: priced.reservation,
                  quote: priced.advertisedQuote,
                }),
                priced: {
                  kind: priced.kind,
                  reservation: priced.reservation,
                  quote: customerQuote,
                },
                customerSummary: PayState.summary({
                  reservation: priced.reservation,
                  quote: customerQuote,
                }),
              })
            )
          ),
        office: (priced) =>
          quote({
            ...input,
            advertisement: { ...input.advertisement, priced },
          }).pipe(
            Effect.map((customerQuote) =>
              customerQuoteVerdict({
                quoted: input,
                advertisedSummary: PayState.summary({
                  reservation: priced.reservation,
                  quote: priced.advertisedQuote,
                }),
                priced: {
                  kind: priced.kind,
                  reservation: priced.reservation,
                  quote: customerQuote,
                },
                customerSummary: PayState.summary({
                  reservation: priced.reservation,
                  quote: customerQuote,
                }),
              })
            )
          ),
      })
    ),
});
