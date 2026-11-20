"use client";

import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { getAccountSignInPath } from "@/features/account/routes";
import {
  CheckoutFlowLayout,
  CheckoutSteps,
} from "@/features/checkout/components/checkout-flow-layout";
import { getWorkspaceProductMonitorTitle } from "@/features/checkout/product-catalog.i18n";
import { type Locale, m } from "@/features/i18n";
import { type OrderId, orderIdSchema } from "@/features/order";
import { defaultReservationBillingSelection } from "@/features/reservation/reservation-billing";
import { formatCount } from "@/shared/utils/number";
import type { PlainDate } from "@/shared/utils/temporal";
import { unlimitedPassDays } from "../pass-offer";
import { getPassTierName } from "../pass-offer.i18n";
import type {
  PassPurchaseBuyer,
  passPurchaseDetailsSchema,
} from "../pass-purchase-details";
import type { UnlimitedPassSelection } from "../unlimited-pass";
import {
  getUnlimitedPassChoosePath,
  getUnlimitedPassDetailsPath,
  getUnlimitedPassPayPath,
  type UnlimitedPassAvailabilityData,
  type UnlimitedPassOptions,
} from "../unlimited-pass-checkout";
import {
  PassPurchasePay,
  type PassPurchasePaymentActions,
  type PassPurchasePayState,
} from "./pass-purchase-pay";
import {
  type UnlimitedPassAvailability,
  UnlimitedPassChoose,
} from "./unlimited-pass-choose";
import { UnlimitedPassDetails } from "./unlimited-pass-details";

type DetailsSchema = ReturnType<typeof passPurchaseDetailsSchema>;
type CheckoutStep =
  | { readonly kind: "choose" }
  | { readonly kind: "details"; readonly selection: UnlimitedPassSelection }
  | {
      readonly kind: "pay";
      readonly orderId: OrderId;
      readonly selection: UnlimitedPassSelection;
      readonly state: PassPurchasePayState;
      readonly retry?: true;
    };
const checkoutStages = {
  choose: "chooseSpace",
  details: "contact",
  pay: "pay",
} as const;

type UnlimitedPassCheckoutProps = PassPurchasePaymentActions & {
  readonly locale: Locale;
  readonly buyer: PassPurchaseBuyer;
  readonly initialOptions: UnlimitedPassOptions;
  readonly initialStartDate?: PlainDate;
  readonly initialDetails?: UnlimitedPassSelection;
  readonly initialBounds: Pick<
    UnlimitedPassAvailabilityData,
    "today" | "lastStartDate"
  >;
  readonly draft?: { readonly orderId: OrderId; readonly holderEmail?: string };
  readonly retryPayment?: {
    readonly orderId: OrderId;
    readonly selection: UnlimitedPassSelection;
    readonly state: PassPurchasePayState;
  };
  readonly discountCodeEntryEnabled: boolean;
  readonly getAvailability: (input: { locale: Locale }) => Promise<{
    data?: UnlimitedPassAvailabilityData;
    serverError?: string;
  }>;
  readonly beginCheckout: (input: {
    orderId: OrderId;
    locale: Locale;
    selection: UnlimitedPassSelection;
    buyerEmail: string;
    holderEmail?: string;
    buyerProfile?: DetailsSchema["Type"]["buyerProfile"];
  }) => Promise<{
    data?:
      | (Omit<PassPurchasePayState, "billing"> & { status: "ready" })
      | { status: "signed_out" | "terms_changed" }
      | { status: "purchase_error"; reason: string };
    serverError?: string;
  }>;
};

export function UnlimitedPassCheckout({
  locale,
  buyer,
  initialOptions,
  initialStartDate,
  initialDetails,
  initialBounds,
  draft,
  retryPayment,
  discountCodeEntryEnabled,
  getAvailability,
  beginCheckout,
  payCheckout,
  repriceCheckout,
}: UnlimitedPassCheckoutProps) {
  const [options, setOptions] = useState(initialOptions);
  const [startDate, setStartDate] = useState(initialStartDate);
  const [step, setStep] = useState<CheckoutStep>(() => {
    if (retryPayment) return { kind: "pay", retry: true, ...retryPayment };
    if (initialDetails) return { kind: "details", selection: initialDetails };
    return { kind: "choose" };
  });
  const [paymentRequested, setPaymentRequested] = useState(false);
  const [details, setDetails] = useState<DetailsSchema["Encoded"] | undefined>(
    draft?.holderEmail
      ? {
          holderEmail: draft.holderEmail,
          billing: defaultReservationBillingSelection,
        }
      : undefined
  );
  const [error, setError] = useState<string>();
  const [savedOrderId, setSavedOrderId] = useState(draft?.orderId);
  const detailRevision = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const attempt = useRef(draft);
  const availability = useQuery({
    queryKey: ["unlimited-pass-availability", locale],
    queryFn: async () => {
      const fallback = m.reservationAvailabilityError({}, { locale });
      const result = await getAvailability({ locale }).catch(() => ({
        data: undefined,
        serverError: fallback,
      }));
      if (!result.data) throw new Error(result.serverError ?? fallback);
      return result.data;
    },
    enabled: step.kind === "choose",
    retry: false,
  });
  // While refreshing, wait for a new result before moving on from Choose.
  let calendarAvailability: UnlimitedPassAvailability = { status: "loading" };
  if (!availability.isFetching) {
    if (availability.isError) {
      calendarAvailability = {
        status: "unavailable",
        message: availability.error.message,
      };
    } else if (availability.data) {
      calendarAvailability = {
        status: "ready",
        starts: availability.data.starts,
      };
    }
  }

  const focusStep = (next: CheckoutStep, nextError?: string) => {
    detailRevision.current += 1;
    setError(nextError);
    setStep(next);
    requestAnimationFrame(() => heading.current?.focus());
  };

  const goToChoose = (nextError?: string) => {
    window.history.replaceState(
      null,
      "",
      getUnlimitedPassChoosePath(locale, options, startDate)
    );
    focusStep({ kind: "choose" }, nextError);
  };

  const updateSelection = (
    nextOptions: UnlimitedPassOptions,
    nextDate?: PlainDate
  ) => {
    attempt.current = undefined;
    setSavedOrderId(undefined);
    setError(undefined);
    setOptions(nextOptions);
    setStartDate(nextDate);
    window.history.replaceState(
      null,
      "",
      getUnlimitedPassChoosePath(locale, nextOptions, nextDate)
    );
  };

  const goToDetails = (
    selection: UnlimitedPassSelection,
    orderId?: OrderId
  ) => {
    window.history.replaceState(
      null,
      "",
      getUnlimitedPassDetailsPath(locale, selection, orderId)
    );
    focusStep({ kind: "details", selection });
  };

  const submitDetails = async (values: DetailsSchema["Type"]) => {
    if (
      step.kind !== "details" ||
      (buyer.kind !== "linked" && buyer.kind !== "profile-required")
    )
      return;
    const { selection } = step;
    setError(undefined);
    setDetails(values);
    const holderEmail =
      values.holderEmail?.toLowerCase() === buyer.email.toLowerCase()
        ? undefined
        : values.holderEmail;
    if (!attempt.current || attempt.current.holderEmail !== holderEmail) {
      attempt.current = {
        orderId: orderIdSchema.make(crypto.randomUUID()),
        ...(holderEmail !== undefined && { holderEmail }),
      };
    }
    const { orderId } = attempt.current;
    const revision = ++detailRevision.current;
    try {
      const result = await beginCheckout({
        orderId,
        locale,
        selection,
        buyerEmail: buyer.email,
        ...(holderEmail !== undefined && { holderEmail }),
        ...(values.buyerProfile !== undefined && {
          buyerProfile: values.buyerProfile,
        }),
      });
      if (detailRevision.current !== revision) return;
      if (result.data?.status === "signed_out") {
        window.location.assign(
          getAccountSignInPath(
            locale,
            getUnlimitedPassDetailsPath(
              locale,
              selection,
              savedOrderId === orderId ? orderId : undefined
            )
          )
        );
      } else if (result.data?.status === "ready") {
        window.history.replaceState(
          null,
          "",
          getUnlimitedPassDetailsPath(locale, selection, orderId)
        );
        setSavedOrderId(orderId);
        setPaymentRequested(false);
        focusStep({
          kind: "pay",
          orderId,
          selection,
          state: {
            ...result.data,
            billing: values.billing,
            ...(holderEmail !== undefined && { holderEmail }),
          },
        });
      } else if (
        result.data?.status === "purchase_error" &&
        result.data.reason === "start-unavailable"
      ) {
        attempt.current = undefined;
        setSavedOrderId(undefined);
        void availability.refetch();
        goToChoose(m.unlimitedPassCheckoutStartUnavailable({}, { locale }));
      } else {
        setError(
          result.serverError ?? m.actionFailedUnexpectedly({}, { locale })
        );
      }
    } catch {
      if (detailRevision.current === revision) {
        setError(m.actionFailedUnexpectedly({}, { locale }));
      }
    }
  };

  const stage = checkoutStages[step.kind];
  const days = formatCount(unlimitedPassDays, locale);
  const bounds = availability.data ?? initialBounds;
  return (
    <CheckoutFlowLayout
      activeStepKey={stage}
      locale={locale}
      steps={
        <CheckoutSteps
          activeStepKey={stage}
          label={m.entryPackCheckoutSteps({}, { locale })}
          labels={{
            chooseSpace: m.unlimitedPassCheckoutChoose({ days }, { locale }),
            contact: m.entryPackCheckoutDetails({}, { locale }),
          }}
          locale={locale}
          stepLinks={{
            ...(step.kind === "details" && {
              chooseSpace: { onSelect: () => goToChoose() },
            }),
            ...(step.kind === "pay" &&
              !step.retry &&
              !paymentRequested && {
                contact: {
                  onSelect: () => goToDetails(step.selection, step.orderId),
                },
              }),
          }}
        />
      }
    >
      {step.kind !== "pay" && (
        <h1
          ref={heading}
          tabIndex={-1}
          className="text-4xl leading-tight text-balance sm:text-5xl"
        >
          {m.unlimitedPassCheckoutTitle({}, { locale })}
        </h1>
      )}
      {step.kind === "choose" && (
        <>
          <p role="alert" className="empty:sr-only text-sm font-semibold">
            {error}
          </p>
          <UnlimitedPassChoose
            locale={locale}
            today={bounds.today}
            lastStartDate={bounds.lastStartDate}
            options={options}
            startDate={startDate}
            availability={calendarAvailability}
            onOptionsChange={(next) => updateSelection(next, startDate)}
            onStartDateChange={(next) => updateSelection(options, next)}
            onRetry={() => void availability.refetch()}
            onContinue={(selection) => goToDetails(selection, savedOrderId)}
          />
        </>
      )}
      {step.kind === "details" && (
        <UnlimitedPassDetails
          buyer={buyer}
          locale={locale}
          selection={step.selection}
          initialValues={details}
          orderId={savedOrderId}
          error={error}
          onChangeSelection={goToChoose}
          onSubmit={submitDetails}
        />
      )}
      {step.kind === "pay" && (
        <PassPurchasePay
          locale={locale}
          orderId={step.orderId}
          state={step.state}
          orderLabel={m.unlimitedPassCheckoutOrderLabel(
            { tier: getPassTierName(step.selection.tier, locale) },
            { locale }
          )}
          orderDetail={getOrderDetail(step.selection, locale, days)}
          repriceCheckout={repriceCheckout}
          payCheckout={payCheckout}
          discountCodeEntryEnabled={discountCodeEntryEnabled && !step.retry}
          signInPath={getAccountSignInPath(
            locale,
            step.retry
              ? getUnlimitedPassPayPath(locale, step.orderId)
              : getUnlimitedPassDetailsPath(
                  locale,
                  step.selection,
                  step.orderId
                )
          )}
          headingRef={heading}
          onRequestPayment={() => setPaymentRequested(true)}
          onExpire={() => {
            attempt.current = undefined;
            setSavedOrderId(undefined);
            void availability.refetch();
            goToChoose();
          }}
        />
      )}
    </CheckoutFlowLayout>
  );
}

function getOrderDetail(
  selection: UnlimitedPassSelection,
  locale: Locale,
  days: string
) {
  if (selection.tier === "reserved-desk-workstation") {
    return getWorkspaceProductMonitorTitle(selection.monitorOption, locale);
  }
  if (selection.tier === "open-space" && selection.coffee) {
    return m.unlimitedPassCheckoutCoffee({ days }, { locale });
  }
}
