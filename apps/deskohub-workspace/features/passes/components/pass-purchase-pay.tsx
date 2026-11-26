import Interpolate from "@doist/react-interpolate";
import Link from "next/link";
import { type Ref, useId, useState } from "react";
import { getAccountSectionPath } from "@/features/account/routes";
import type { PaymentAttemptId } from "@/features/checkout/checkout-identifiers";
import {
  CheckoutPayCard,
  CheckoutPayConsent,
  CheckoutPayProviderHandoff,
  CheckoutPaySubmitButton,
} from "@/features/checkout/components/checkout-pay-page-card";
import { openCheckoutPaymentWindow } from "@/features/checkout/components/checkout-payment-window";
import { CheckoutSummaryLine } from "@/features/checkout/components/checkout-summary-line";
import {
  CheckoutSummarySection,
  CheckoutSummarySections,
} from "@/features/checkout/components/checkout-summary-section";
import { type Locale, m } from "@/features/i18n";
import type { PaymentSubmitLegalDocument } from "@/features/legal/payment-submit-evidence";
import type { OrderId } from "@/features/order";
import type { ReservationBillingSelection } from "@/features/reservation/reservation-billing";
import { reservationStatusPath } from "@/features/reservation/routes";
import { Button } from "@/shared/components/ui/button";
import { Checkbox } from "@/shared/components/ui/checkbox";
import { ChoiceCard } from "@/shared/components/ui/choice-card";
import { Input } from "@/shared/components/ui/input";
import { textLink } from "@/shared/components/ui/text-link";
import { formatMoney } from "@/shared/money/money";
import { formatCount } from "@/shared/utils/number";
import { useWorkspaceAction } from "@/shared/utils/use-workspace-action";
import type { EntryPackCheckoutPrice } from "../entry-pack-checkout";
import type {
  payEntryPackCheckout,
  repriceEntryPackCheckout,
} from "../entry-pack-checkout-actions";
import { unlimitedPassDays } from "../pass-offer";
import { formatPassDate } from "../pass-offer.i18n";
import type { UnlimitedAutoRenewalDisclosure } from "../unlimited-auto-renewal";

export type PassPurchasePayState = {
  readonly price: EntryPackCheckoutPrice;
  readonly autoRenew?: true;
  readonly disclosure: {
    readonly documents: readonly PaymentSubmitLegalDocument[];
    readonly earlyStartRequest?: string;
    readonly renewal?: UnlimitedAutoRenewalDisclosure;
  };
  readonly validFrom: string;
  readonly lastUsableDate: string;
  readonly billing: ReservationBillingSelection;
  readonly priorPaymentAttemptId?: PaymentAttemptId;
  readonly holderEmail?: string;
};

export type PassPurchasePaymentActions = {
  readonly repriceCheckout: typeof repriceEntryPackCheckout;
  readonly payCheckout: typeof payEntryPackCheckout;
};

export type PassPurchasePayProps = {
  readonly locale: Locale;
  readonly orderId: OrderId;
  readonly discountCodeEntryEnabled: boolean;
  readonly headingRef: Ref<HTMLHeadingElement>;
  readonly onExpire: () => void;
  readonly onRequestPayment: () => void;
};

export function PassPurchasePay({
  locale,
  orderId,
  state,
  discountCodeEntryEnabled,
  signInPath,
  orderLabel,
  product,
  orderDetail,
  returnExpiredQuoteToStatus,
  repriceCheckout,
  payCheckout,
  headingRef,
  onExpire,
  onRequestPayment,
}: PassPurchasePayProps &
  PassPurchasePaymentActions & {
    readonly state: PassPurchasePayState;
    readonly signInPath: string;
    readonly orderLabel: string;
    readonly product: "entry-pack" | "unlimited";
    readonly orderDetail?: string;
    readonly returnExpiredQuoteToStatus?: boolean;
  }) {
  const [price, setPrice] = useState(state.price);
  const [disclosure, setDisclosure] = useState(state.disclosure);
  const [checked, setChecked] = useState(false);
  const [earlyStartChecked, setEarlyStartChecked] = useState(false);
  const [renewalChecked, setRenewalChecked] = useState(false);
  const renewal = state.autoRenew ? disclosure.renewal : undefined;
  const consentComplete =
    checked &&
    (!renewal ||
      (renewalChecked && (!disclosure.earlyStartRequest || earlyStartChecked)));
  const { appliedDiscountCode } = price;
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string>();
  const [expired, setExpired] = useState(false);
  const quoteUnavailable = expired || (state.autoRenew === true && !renewal);
  const renewalRequiresPayment =
    state.autoRenew === true && price.total.value <= 0;
  const consentId = useId();
  const earlyStartConsentId = useId();
  const renewalConsentId = useId();
  const codeId = useId();
  const input = { locale, orderId };
  const showError = () => setError(m.actionFailedUnexpectedly({}, { locale }));
  const signIn = () => window.location.assign(signInPath);
  const goToStatus = () =>
    window.location.replace(`/${locale}${reservationStatusPath}/${orderId}`);
  const clearConsent = () => {
    setChecked(false);
    setEarlyStartChecked(false);
    setRenewalChecked(false);
  };

  function handlePurchaseFailure(reason: string) {
    if (reason === "billing-changed" || reason === "payment-in-progress") {
      goToStatus();
    } else if (reason === "quote-expired") {
      if (returnExpiredQuoteToStatus) {
        goToStatus();
        return;
      }
      setExpired(true);
      setError(m.entryPackCheckoutQuoteExpired({}, { locale }));
    } else {
      showError();
    }
  }

  const reprice = useWorkspaceAction(repriceCheckout, {
    onError: showError,
    onSuccess({ data }) {
      if (data.status === "ready") {
        setPrice(data.price);
        setDraft("");
        clearConsent();
      } else if (data.status === "pricing_changed") {
        setPrice(data.price);
        clearConsent();
        setError(m.checkoutPayPricingChangedLead({}, { locale }));
      } else if (data.status === "code_unavailable") {
        setError(m.checkoutDiscountCodeUnavailable({}, { locale }));
      } else if (data.status === "signed_out") {
        signIn();
      } else if (data.status === "terms_changed") {
        setDisclosure(data.disclosure);
        clearConsent();
        setError(m.entryPackCheckoutTermsChanged({}, { locale }));
      } else if (data.status === "purchase_error") {
        handlePurchaseFailure(data.reason);
      }
    },
  });
  const pay = useWorkspaceAction(payCheckout, {
    onError: showError,
    onSuccess({ data }) {
      if (data.status === "hosted") {
        if (openCheckoutPaymentWindow(data.redirectUrl, data.statusUrl))
          window.location.replace(data.statusUrl);
        else window.location.assign(data.redirectUrl);
      } else if (data.status === "paid" || data.status === "pending") {
        window.location.replace(data.statusUrl);
      } else if (data.status === "pricing_changed") {
        setPrice(data.price);
        clearConsent();
        setError(m.checkoutPayPricingChangedLead({}, { locale }));
      } else if (data.status === "signed_out") {
        signIn();
      } else if (data.status === "terms_changed") {
        setDisclosure(data.disclosure);
        clearConsent();
        setError(m.entryPackCheckoutTermsChanged({}, { locale }));
      } else if (data.status === "purchase_error") {
        handlePurchaseFailure(data.reason);
      }
    },
  });
  const busy = reprice.isPending || pay.isPending;
  const updateCode = (code?: string) => {
    setError(undefined);
    setRenewalChecked(false);
    reprice.execute({
      ...input,
      displayedPriceFingerprint: price.fingerprint,
      ...(code !== undefined && { submittedCode: code }),
    });
  };
  const submitPayment = () => {
    if (!consentComplete || busy || quoteUnavailable || renewalRequiresPayment)
      return;
    setError(undefined);
    setRenewalChecked(false);
    onRequestPayment();
    pay.execute({
      ...input,
      accepted: checked,
      ...(product === "unlimited" && {
        unlimitedEarlyStartAccepted:
          Boolean(disclosure.earlyStartRequest) &&
          (!renewal || earlyStartChecked),
      }),
      ...(renewal &&
        renewalChecked && {
          renewalAuthorization: {
            amount: renewal.amount,
            nextRenewalOn: renewal.nextRenewalOn,
            termsHash: renewal.termsHash,
          },
        }),
      acceptedDocuments: disclosure.documents.map(({ key, hash }) => ({
        key,
        hash,
      })),
      billing: state.billing,
      displayedPriceFingerprint: price.fingerprint,
      ...(state.priorPaymentAttemptId && {
        priorPaymentAttemptId: state.priorPaymentAttemptId,
      }),
    });
  };

  return (
    <CheckoutPayCard
      headingRef={headingRef}
      title={m.checkoutPayTitle({}, { locale })}
    >
      <CheckoutSummarySections>
        <CheckoutSummarySection sectionKey="order" locale={locale}>
          <CheckoutSummaryLine
            label={orderLabel}
            amount={price.total}
            detail={
              <>
                <span className="block">
                  {formatPassDate(state.validFrom, locale)} –{" "}
                  {formatPassDate(state.lastUsableDate, locale)}
                </span>
                {orderDetail && <span className="block">{orderDetail}</span>}
                {state.holderEmail && (
                  <span className="block break-all">
                    {m.entryPackCheckoutOrderHolder(
                      { email: state.holderEmail },
                      { locale }
                    )}
                  </span>
                )}
                {price.discounts.map(({ id, label, amount }) => (
                  <span
                    key={id}
                    className="block font-semibold text-aquamarine-ink"
                  >
                    {label} · −{formatMoney(amount, locale)}
                  </span>
                ))}
              </>
            }
            locale={locale}
          >
            {price.discounts.length > 0 && (
              <del className="order-first text-navy-blue/55">
                {formatMoney(price.subtotal, locale)}
              </del>
            )}
          </CheckoutSummaryLine>
        </CheckoutSummarySection>
        <CheckoutSummarySection sectionKey="total" locale={locale}>
          <CheckoutSummaryLine
            label={m.checkoutSummaryItemTotal({}, { locale })}
            amount={price.total}
            locale={locale}
          />
        </CheckoutSummarySection>
      </CheckoutSummarySections>
      {renewal && (
        <div className="space-y-2 rounded-2xl border border-navy-blue/10 bg-white p-4 text-sm leading-6 text-navy-blue/75">
          <p className="font-semibold text-navy-blue">
            {m.unlimitedPassCheckoutAutoRenewSchedule(
              {
                amount: formatMoney(renewal.amount, locale),
                date: formatPassDate(renewal.nextRenewalOn, locale),
                days: formatCount(unlimitedPassDays, locale),
              },
              { locale }
            )}
          </p>
          <p>
            <Interpolate
              string={m.unlimitedPassCheckoutAutoRenewReminder({}, { locale })}
              mapping={{
                account: (label) => (
                  <Link
                    href={getAccountSectionPath(locale, "passes")}
                    className={textLink({ tone: "inherit" })}
                  >
                    {label}
                  </Link>
                ),
                terms: (label) => (
                  <Link
                    href={renewal.termsPath}
                    prefetch={false}
                    target="_blank"
                    rel="noreferrer"
                    className={textLink({ tone: "inherit" })}
                  >
                    {label}
                  </Link>
                ),
              }}
            />
          </p>
        </div>
      )}
      {discountCodeEntryEnabled &&
        (appliedDiscountCode ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-aquamarine-green/40 bg-aquamarine-green/15 p-3 text-sm">
            <span>
              {m.entryPackCheckoutCodeApplied(
                { code: appliedDiscountCode },
                { locale }
              )}
            </span>
            <Button
              disabled={busy || quoteUnavailable}
              variant="link"
              type="button"
              onClick={() => updateCode()}
            >
              {m.checkoutDiscountCodeRemove({}, { locale })}
            </Button>
          </div>
        ) : (
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (draft.trim() && !busy && !quoteUnavailable) updateCode(draft);
            }}
          >
            <label htmlFor={codeId} className="font-semibold text-sm">
              {m.checkoutDiscountCodeLabel({}, { locale })}
            </label>
            <div className="flex flex-wrap gap-2">
              <Input
                id={codeId}
                disabled={busy || quoteUnavailable}
                className="min-w-40 flex-1"
                autoComplete="off"
                maxLength={160}
                value={draft}
                onChange={(event) => setDraft(event.currentTarget.value)}
              />
              <Button
                disabled={!draft.trim() || busy || quoteUnavailable}
                variant="secondary"
                type="submit"
              >
                {m.checkoutDiscountCodeApply({}, { locale })}
              </Button>
            </div>
          </form>
        ))}
      {price.total.value > 0 && <CheckoutPayProviderHandoff locale={locale} />}
      <div className="space-y-6">
        <p
          role="alert"
          className="empty:sr-only text-sm font-semibold text-burned-orange"
        >
          {error ??
            (renewalRequiresPayment &&
              m.unlimitedPassCheckoutAutoRenewRequiresPayment({}, { locale }))}
        </p>
        <CheckoutPayConsent
          checked={checked}
          disabled={busy || quoteUnavailable}
          {...(!renewal &&
            disclosure.earlyStartRequest !== undefined && {
              earlyStartRequest: disclosure.earlyStartRequest,
            })}
          id={consentId}
          locale={locale}
          onCheckedChange={setChecked}
          variant="pay"
        />
        {renewal && disclosure.earlyStartRequest && (
          <ChoiceCard htmlFor={earlyStartConsentId}>
            <Checkbox
              id={earlyStartConsentId}
              className="mt-1"
              checked={earlyStartChecked}
              disabled={busy || quoteUnavailable}
              onCheckedChange={(value) => setEarlyStartChecked(value === true)}
            />
            <span className="text-sm leading-6 text-navy-blue/66">
              {disclosure.earlyStartRequest}
            </span>
          </ChoiceCard>
        )}
        {renewal && (
          <ChoiceCard htmlFor={renewalConsentId}>
            <Checkbox
              id={renewalConsentId}
              className="mt-1"
              checked={renewalChecked}
              disabled={busy || quoteUnavailable}
              onCheckedChange={(value) => setRenewalChecked(value === true)}
            />
            <span className="text-sm leading-6 text-navy-blue/66">
              {m.unlimitedPassCheckoutAutoRenewConsent({}, { locale })}
            </span>
          </ChoiceCard>
        )}
        {quoteUnavailable ? (
          <Button
            type="button"
            onClick={returnExpiredQuoteToStatus ? goToStatus : onExpire}
          >
            {m.entryPackCheckoutRefreshQuote({}, { locale })}
          </Button>
        ) : (
          <CheckoutPaySubmitButton
            disabled={!consentComplete || busy || renewalRequiresPayment}
            locale={locale}
            onClick={submitPayment}
            pending={pay.isPending}
            total={price.total}
            variant="pay"
          />
        )}
      </div>
    </CheckoutPayCard>
  );
}
