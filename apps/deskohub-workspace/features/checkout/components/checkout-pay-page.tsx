"use client";

import Link from "next/link";
import { type ReactNode, useId, useState } from "react";
import type {
  CheckoutSummaryChangedKeys,
  CheckoutSummary as CheckoutSummaryData,
} from "@/features/checkout/checkout-summary";
import { CheckoutBanner } from "@/features/checkout/components/checkout-banner";
import { CheckoutDiscountCountdownBanner } from "@/features/checkout/components/checkout-discount-countdown-banner";
import { CheckoutSummary } from "@/features/checkout/components/checkout-summary";
import { type Locale, m } from "@/features/i18n";
import {
  type OfficeCheckoutPeople,
  OfficeCheckoutPeopleReview,
} from "@/features/office/components/office-checkout-people";
import { getCoworkReservationPath } from "@/features/reservation/routes";
import { Button } from "@/shared/components/ui/button";
import {
  CheckoutPayCard,
  CheckoutPayConsent,
  CheckoutPayProviderHandoff,
  CheckoutPaySubmitButton,
} from "./checkout-pay-page-card";
import {
  type CheckoutPaymentMethod,
  type StartCheckoutPaymentAction,
  useCheckoutPaySubmission,
} from "./use-checkout-pay-submission";

type CheckoutPayPageProps = {
  readonly changedKeys?: CheckoutSummaryChangedKeys;
  readonly discountCodeForm?: ReactNode;
  readonly earlyPerformanceRequestRequired?: boolean;
  readonly freshPayUrl?: string;
  readonly locale: Locale;
  /** An office order's first day, which its order line names. */
  readonly officeStartDateLabel?: string;
  readonly payStateToken?: string;
  /** Who is coming to an office order with a people list. */
  readonly people?: OfficeCheckoutPeople;
  readonly startPaymentAction?: StartCheckoutPaymentAction;
  readonly summary: CheckoutSummaryData;
  readonly usesEntryPack?: boolean;
  readonly variant: "pay" | "retry" | "pricingChanged";
  readonly retryOutcome?: "cancelled" | "failed";
};

export function CheckoutPayPage({
  changedKeys,
  discountCodeForm,
  earlyPerformanceRequestRequired = true,
  freshPayUrl,
  locale,
  officeStartDateLabel,
  payStateToken,
  people,
  retryOutcome,
  startPaymentAction,
  summary,
  usesEntryPack = false,
  variant,
}: CheckoutPayPageProps) {
  const [method, setMethod] = useState<CheckoutPaymentMethod>("card");
  const paymentMethodName = useId();
  const providerTotal = summary.total.value > 0 ? summary.total : undefined;
  const offersQr = Boolean(
    startPaymentAction &&
      !usesEntryPack &&
      payStateToken &&
      variant === "pay" &&
      providerTotal?.currency === "CZK"
  );
  const paymentMethod = offersQr ? method : "card";
  const {
    errorMessage,
    isSubmitPending,
    legalConsent,
    setLegalConsent,
    submit,
  } = useCheckoutPaySubmission({
    earlyPerformanceRequestRequired,
    locale,
    method: paymentMethod,
    payStateToken,
    startPaymentAction: offersQr ? startPaymentAction : undefined,
  });
  const isPricingChanged = variant === "pricingChanged";
  const title = {
    pay:
      usesEntryPack && providerTotal
        ? m.coworkEntryPackPayAddon({}, { locale })
        : m.checkoutPayTitle({}, { locale }),
    retry: m.checkoutPaymentRetryTitle({}, { locale }),
    pricingChanged: m.checkoutPayPricingChangedTitle({}, { locale }),
  }[variant];
  const lead = {
    pay: null,
    retry: m.checkoutPaymentRetryLead({}, { locale }),
    pricingChanged: m.checkoutPayPricingChangedLead({}, { locale }),
  }[variant];
  const actionVariant = (
    {
      pay: "pay",
      retry: "retry",
      pricingChanged: "pay",
    } as const
  )[variant];
  return (
    <CheckoutPayCard lead={lead} title={title}>
      <CheckoutPayNotices
        isPricingChanged={isPricingChanged}
        locale={locale}
        retryOutcome={retryOutcome}
      />

      <CheckoutDiscountCountdownBanner locale={locale} summary={summary} />

      {people ? (
        <div className="@container">
          <div className="grid items-start gap-3 @3xl:grid-cols-2">
            <CheckoutSummary
              changedKeys={changedKeys}
              locale={locale}
              officeStartDateLabel={officeStartDateLabel}
              summary={summary}
            />
            <OfficeCheckoutPeopleReview locale={locale} people={people} />
          </div>
        </div>
      ) : (
        <CheckoutSummary
          changedKeys={changedKeys}
          locale={locale}
          officeStartDateLabel={officeStartDateLabel}
          summary={summary}
          usesEntryPack={usesEntryPack}
        />
      )}

      {variant === "pay" && discountCodeForm}

      {isPricingChanged ? (
        <CheckoutPayUpdatedPriceLink
          freshPayUrl={freshPayUrl}
          locale={locale}
        />
      ) : (
        <>
          {offersQr && (
            <fieldset disabled={isSubmitPending}>
              <legend className="mb-2 text-sm font-semibold">
                {m.checkoutPayMethod({}, { locale })}
              </legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {(
                  [
                    ["card", m.checkoutPayMethodCard({}, { locale })],
                    ["qr", m.checkoutPayMethodQr({}, { locale })],
                  ] as const
                ).map(([option, label]) => (
                  <label
                    className="flex cursor-pointer items-center gap-2 rounded-xl border border-navy-blue/15 px-3 py-3 text-sm font-semibold has-checked:border-navy-blue/55 has-checked:bg-navy-blue/5 has-disabled:cursor-default"
                    key={option}
                  >
                    <input
                      checked={paymentMethod === option}
                      className="size-4 accent-navy-blue"
                      name={paymentMethodName}
                      onChange={() => setMethod(option)}
                      type="radio"
                      value={option}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <CheckoutPayConsent
            checked={legalConsent}
            id="checkout-pay-legal-consent"
            locale={locale}
            onCheckedChange={setLegalConsent}
            showEarlyPerformanceRequest={earlyPerformanceRequestRequired}
            variant={actionVariant}
          />

          <CheckoutPaySubmitButton
            disabled={!legalConsent || isSubmitPending}
            freeOrderLabel={
              usesEntryPack
                ? m.coworkEntryPackBookWithEntry({}, { locale })
                : undefined
            }
            locale={locale}
            method={paymentMethod}
            onClick={submit}
            pending={isSubmitPending}
            total={providerTotal}
            variant={actionVariant}
          />

          {!!providerTotal && paymentMethod === "card" && (
            <CheckoutPayProviderHandoff locale={locale} />
          )}
        </>
      )}

      {!!errorMessage && (
        <CheckoutBanner role="alert">{errorMessage}</CheckoutBanner>
      )}
    </CheckoutPayCard>
  );
}

/** Why the customer is back on the Pay page, when they are. */
function CheckoutPayNotices({
  isPricingChanged,
  locale,
  retryOutcome,
}: {
  readonly isPricingChanged: boolean;
  readonly locale: Locale;
  readonly retryOutcome: CheckoutPayPageProps["retryOutcome"];
}) {
  return (
    <>
      {!!retryOutcome && (
        <CheckoutBanner>
          {
            {
              cancelled: m.checkoutPaymentRetryCancelledBanner({}, { locale }),
              failed: m.checkoutPaymentRetryFailedBanner({}, { locale }),
            }[retryOutcome]
          }
        </CheckoutBanner>
      )}

      {isPricingChanged && (
        <CheckoutBanner>
          {m.checkoutPayPricingChangedBanner({}, { locale })}
        </CheckoutBanner>
      )}
    </>
  );
}

function CheckoutPayUpdatedPriceLink({
  freshPayUrl,
  locale,
}: {
  readonly freshPayUrl: string | undefined;
  readonly locale: Locale;
}) {
  return (
    <Button asChild size="xl" caps fullWidth>
      <Link
        href={freshPayUrl ?? getCoworkReservationPath(locale)}
        prefetch={false}
      >
        {m.checkoutPayReviewUpdatedPriceButton({}, { locale })}
      </Link>
    </Button>
  );
}
