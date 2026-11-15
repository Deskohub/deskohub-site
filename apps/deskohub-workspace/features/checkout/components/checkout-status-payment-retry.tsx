"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { preparePaymentRetry } from "@/features/checkout/actions/prepare-payment-retry";
import { CheckoutBanner } from "@/features/checkout/components/checkout-banner";
import { type Locale, m } from "@/features/i18n";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import { Button } from "@/shared/components/ui/button";
import { useWorkspaceAction } from "@/shared/utils/use-workspace-action";

type Refusal = "spot_unavailable" | "refused";

/**
 * The status page's action row led by a button that pays the same order
 * again on its Pay page. When the order can't be paid again in place,
 * `fallback`, the link that books the selection again, takes the button's
 * place, after a notice when the spot was taken, and the status refreshes.
 * A payment that may still settle refreshes the status alone. A failure
 * shows in an alert region that stays mounted.
 */
export function CheckoutStatusPaymentRetry({
  children,
  className,
  fallback,
  locale,
  orderId,
}: {
  readonly children?: ReactNode;
  readonly className: string;
  readonly fallback: ReactNode;
  readonly locale: Locale;
  readonly orderId: WorkspaceReservationId;
}) {
  const router = useRouter();
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const showError = () =>
    setErrorMessage(m.checkoutPaymentRetryError({}, { locale }));
  const { execute, isExecuting } = useWorkspaceAction(preparePaymentRetry, {
    onSuccess: ({ data }) => {
      if (!data) {
        showError();
        return;
      }
      switch (data.state) {
        case "ready":
          setLeaving(true);
          router.push(data.payUrl);
          return;
        case "payment_settling":
          router.refresh();
          return;
        default:
          // The refusal may come from a status that changed since the page
          // rendered, such as a payment that arrived meanwhile.
          setRefusal(data.state);
          router.refresh();
      }
    },
    onError: ({ error }) => {
      setErrorMessage(
        error.serverError || m.checkoutPaymentRetryError({}, { locale })
      );
    },
    onTransportError: showError,
  });
  const pending = isExecuting || leaving;

  const retry = () => {
    if (pending) return;
    setErrorMessage(null);
    execute({ locale, orderId });
  };

  return (
    <>
      <div aria-live="polite">
        {refusal === "spot_unavailable" && (
          <div className="mt-8" id="checkout-status-payment-retry-refusal">
            <CheckoutBanner live={false}>
              {m.checkoutStatusPaymentRetrySpotUnavailable({}, { locale })}
            </CheckoutBanner>
          </div>
        )}
      </div>
      <div className={className}>
        {refusal ? (
          fallback
        ) : (
          <Button
            id="checkout-status-try-payment-again"
            onClick={retry}
            pending={pending}
            size="lg"
            type="button"
          >
            {m.checkoutPaymentRetryButton({}, { locale })}
          </Button>
        )}
        {children}
      </div>
      <div role="alert">
        {!!errorMessage && (
          <div className="mt-4">
            <CheckoutBanner live={false}>{errorMessage}</CheckoutBanner>
          </div>
        )}
      </div>
    </>
  );
}
