import { type Ref, useId, useState } from "react";
import { getAccountSignInPath } from "@/features/account/routes";
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
import type { OrderId } from "@/features/order";
import { reservationStatusPath } from "@/features/reservation/routes";
import { Button } from "@/shared/components/ui/button";
import { Input } from "@/shared/components/ui/input";
import { formatMoney } from "@/shared/money/money";
import { useWorkspaceAction } from "@/shared/utils/use-workspace-action";
import { getEntryPackDetailsPath } from "../entry-pack-checkout";
import {
  payEntryPackCheckout,
  repriceEntryPackCheckout,
} from "../entry-pack-checkout-actions";
import type { EntryPackPayState } from "./entry-pack-checkout";
import { entryPackTierLabel, formatEntryPackDate } from "./entry-pack-choose";

export function EntryPackPay({
  locale,
  orderId,
  state,
  discountCodeEntryEnabled,
  continuationPath,
  headingRef,
  onExpire,
  onRequestPayment,
}: {
  readonly locale: Locale;
  readonly orderId: OrderId;
  readonly state: EntryPackPayState;
  readonly discountCodeEntryEnabled: boolean;
  readonly continuationPath?: string | undefined;
  readonly headingRef: Ref<HTMLHeadingElement>;
  readonly onExpire: () => void;
  readonly onRequestPayment: () => void;
}) {
  const { product } = state;
  const [price, setPrice] = useState(state.price);
  const [disclosure, setDisclosure] = useState(state.disclosure);
  const [checked, setChecked] = useState(false);
  const { appliedDiscountCode } = price;
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string>();
  const [expired, setExpired] = useState(false);
  const consentId = useId();
  const codeId = useId();
  const input = { locale, orderId };
  const showError = () => setError(m.actionFailedUnexpectedly({}, { locale }));
  const signIn = () =>
    window.location.assign(
      getAccountSignInPath(
        locale,
        continuationPath ?? getEntryPackDetailsPath(locale, product, orderId)
      )
    );
  const goToStatus = () =>
    window.location.replace(`/${locale}${reservationStatusPath}/${orderId}`);

  function handlePurchaseFailure(reason: string) {
    if (reason === "billing-changed" || reason === "payment-in-progress") {
      goToStatus();
    } else if (reason === "quote-expired") {
      setExpired(true);
      setError(m.entryPackCheckoutQuoteExpired({}, { locale }));
    } else {
      showError();
    }
  }

  const reprice = useWorkspaceAction(repriceEntryPackCheckout, {
    onError: showError,
    onSuccess({ data }) {
      if (data.status === "ready") {
        setPrice(data.price);
        setDraft("");
        setChecked(false);
      } else if (data.status === "pricing_changed") {
        setPrice(data.price);
        setChecked(false);
        setError(m.checkoutPayPricingChangedLead({}, { locale }));
      } else if (data.status === "code_unavailable") {
        setError(m.checkoutDiscountCodeUnavailable({}, { locale }));
      } else if (data.status === "signed_out") {
        signIn();
      } else if (data.status === "terms_changed") {
        setDisclosure(data.disclosure);
        setChecked(false);
        setError(m.entryPackCheckoutTermsChanged({}, { locale }));
      } else if (data.status === "purchase_error") {
        handlePurchaseFailure(data.reason);
      }
    },
  });
  const pay = useWorkspaceAction(payEntryPackCheckout, {
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
        setChecked(false);
        setError(m.checkoutPayPricingChangedLead({}, { locale }));
      } else if (data.status === "signed_out") {
        signIn();
      } else if (data.status === "terms_changed") {
        setDisclosure(data.disclosure);
        setChecked(false);
        setError(m.entryPackCheckoutTermsChanged({}, { locale }));
      } else if (data.status === "purchase_error") {
        handlePurchaseFailure(data.reason);
      }
    },
  });
  const busy = reprice.isPending || pay.isPending;
  const updateCode = (code?: string) => {
    setError(undefined);
    reprice.execute({
      ...input,
      displayedPriceFingerprint: price.fingerprint,
      ...(code !== undefined && { submittedCode: code }),
    });
  };
  const submitPayment = () => {
    if (!checked || busy || expired) return;
    setError(undefined);
    onRequestPayment();
    pay.execute({
      ...input,
      accepted: checked,
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
            label={m.entryPackCheckoutOrderLabel(
              {
                tier: entryPackTierLabel(product.tier, locale),
                count: product.size,
              },
              { locale }
            )}
            amount={price.total}
            detail={
              <>
                <span className="block">
                  {formatEntryPackDate(state.validFrom, locale)} –{" "}
                  {formatEntryPackDate(state.lastUsableDate, locale)}
                </span>
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
              disabled={busy || expired}
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
              if (draft.trim() && !busy && !expired) updateCode(draft);
            }}
          >
            <label htmlFor={codeId} className="font-semibold text-sm">
              {m.checkoutDiscountCodeLabel({}, { locale })}
            </label>
            <div className="flex flex-wrap gap-2">
              <Input
                id={codeId}
                disabled={busy || expired}
                className="min-w-40 flex-1"
                autoComplete="off"
                maxLength={160}
                value={draft}
                onChange={(event) => setDraft(event.currentTarget.value)}
              />
              <Button
                disabled={!draft.trim() || busy || expired}
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
        {error && (
          <p role="alert" className="text-sm font-semibold text-burned-orange">
            {error}
          </p>
        )}
        <CheckoutPayConsent
          checked={checked}
          disabled={busy || expired}
          earlyStartRequest={disclosure.earlyStartRequest}
          id={consentId}
          locale={locale}
          onCheckedChange={setChecked}
          variant="pay"
        />
        {expired ? (
          <Button type="button" onClick={onExpire}>
            {m.entryPackCheckoutRefreshQuote({}, { locale })}
          </Button>
        ) : (
          <CheckoutPaySubmitButton
            disabled={!checked || busy}
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
