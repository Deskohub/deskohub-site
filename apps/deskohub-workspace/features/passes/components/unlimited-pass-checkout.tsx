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
import { type PlainDate, plainDateStringSchema } from "@/shared/utils/temporal";
import { unlimitedPassDays } from "../pass-offer";
import { formatPassDate, getPassTierName } from "../pass-offer.i18n";
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
  type UnlimitedPassOrderLink,
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
  readonly draft?: UnlimitedPassOrderLink & { readonly holderEmail?: string };
  readonly retryPayment?: {
    readonly orderId: OrderId;
    readonly selection: UnlimitedPassSelection;
    readonly state: PassPurchasePayState;
  };
  readonly discountCodeEntryEnabled: boolean;
  readonly getAvailability: (input: {
    locale: Locale;
    startsOn?: PlainDate;
    supersedeOrderId?: OrderId;
  }) => Promise<{
    data?: UnlimitedPassAvailabilityData | { status: "unavailable" };
    serverError?: string;
  }>;
  readonly beginCheckout: (input: {
    orderId: OrderId;
    locale: Locale;
    selection: UnlimitedPassSelection;
    supersedeOrderId?: OrderId;
    buyerEmail: string;
    holderEmail?: string;
    buyerProfile?: DetailsSchema["Type"]["buyerProfile"];
  }) => Promise<{
    data?:
      | (Omit<PassPurchasePayState, "billing"> & { status: "ready" })
      | { status: "signed_out" | "terms_changed" }
      | { status: "purchase_error"; reason: string }
      | { status: "capacity_unavailable"; blockingDates: readonly string[] };
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
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const firstVisibleDate =
      initialStartDate !== undefined &&
      Temporal.PlainDate.compare(initialStartDate, initialBounds.today) >= 0 &&
      Temporal.PlainDate.compare(
        initialStartDate,
        initialBounds.lastStartDate
      ) <= 0
        ? initialStartDate
        : initialBounds.today;
    return plainDateStringSchema.make(
      Temporal.PlainDate.from(firstVisibleDate).with({ day: 1 }).toString()
    );
  });
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
  const [savedOrderId, setSavedOrderId] = useState(
    draft?.kind === "resume" ? draft.orderId : undefined
  );
  const [activeDraftOrderId, setActiveDraftOrderId] = useState(draft?.orderId);
  const detailRevision = useRef(0);
  const beginPending = useRef(false);
  const [isBeginning, setBeginning] = useState(false);
  const detailsDraft = useRef<() => DetailsSchema["Encoded"]>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const attempt = useRef<
    | {
        readonly orderId: OrderId;
        readonly holderEmail?: string;
        readonly supersedeOrderId?: OrderId;
      }
    | undefined
  >(draft?.kind === "resume" ? draft : undefined);
  const startsOn =
    Temporal.PlainDate.compare(calendarMonth, initialBounds.today) > 0
      ? calendarMonth
      : undefined;
  const availability = useQuery({
    queryKey: [
      "unlimited-pass-availability",
      locale,
      startsOn,
      activeDraftOrderId,
    ],
    queryFn: async () => {
      const fallback = m.reservationAvailabilityError({}, { locale });
      const result = await getAvailability({
        locale,
        ...(startsOn !== undefined && { startsOn }),
        ...(activeDraftOrderId !== undefined && {
          supersedeOrderId: activeDraftOrderId,
        }),
      }).catch(() => ({
        data: undefined,
        serverError: fallback,
      }));
      if (result.data?.status !== "ready")
        throw new Error(result.serverError ?? fallback);
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

  const orderLink = getOrderLink(savedOrderId, activeDraftOrderId);
  const goToChoose = () => {
    if (beginPending.current) return;
    if (detailsDraft.current) setDetails(detailsDraft.current());
    window.history.replaceState(
      null,
      "",
      getUnlimitedPassChoosePath(locale, options, startDate, orderLink)
    );
    focusStep({ kind: "choose" });
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
      getUnlimitedPassChoosePath(
        locale,
        nextOptions,
        nextDate,
        getOrderLink(undefined, activeDraftOrderId)
      )
    );
  };

  const goToDetails = (
    selection: UnlimitedPassSelection,
    order?: UnlimitedPassOrderLink
  ) => {
    window.history.replaceState(
      null,
      "",
      getUnlimitedPassDetailsPath(locale, selection, order)
    );
    focusStep({ kind: "details", selection });
  };

  const submitDetails = async (values: DetailsSchema["Type"]) => {
    if (
      step.kind !== "details" ||
      beginPending.current ||
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
        ...(activeDraftOrderId !== undefined && {
          supersedeOrderId: activeDraftOrderId,
        }),
      };
      if (activeDraftOrderId !== undefined) {
        setSavedOrderId(undefined);
        window.history.replaceState(
          null,
          "",
          getUnlimitedPassDetailsPath(locale, selection, {
            kind: "replace",
            orderId: activeDraftOrderId,
          })
        );
      }
    }
    const { orderId, supersedeOrderId } = attempt.current;
    const revision = ++detailRevision.current;
    beginPending.current = true;
    setBeginning(true);
    try {
      const result = await beginCheckout({
        orderId,
        locale,
        selection,
        ...(supersedeOrderId !== undefined && { supersedeOrderId }),
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
              getOrderLink(
                savedOrderId === orderId ? orderId : undefined,
                supersedeOrderId
              )
            )
          )
        );
      } else if (result.data?.status === "ready") {
        window.history.replaceState(
          null,
          "",
          getUnlimitedPassDetailsPath(locale, selection, {
            kind: "resume",
            orderId,
          })
        );
        setSavedOrderId(orderId);
        setActiveDraftOrderId(orderId);
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
      } else if (result.data?.status === "capacity_unavailable") {
        attempt.current = undefined;
        setSavedOrderId(undefined);
        setStartDate(undefined);
        window.history.replaceState(
          null,
          "",
          getUnlimitedPassChoosePath(
            locale,
            options,
            undefined,
            getOrderLink(undefined, activeDraftOrderId)
          )
        );
        void availability.refetch();
        const dates = new Intl.ListFormat(locale).format(
          result.data.blockingDates.map((date) => formatPassDate(date, locale))
        );
        focusStep(
          { kind: "choose" },
          dates
            ? m.unlimitedPassCheckoutBlockingDates({ dates }, { locale })
            : m.unlimitedPassCheckoutStartUnavailable({}, { locale })
        );
      } else {
        setError(
          result.serverError ?? m.actionFailedUnexpectedly({}, { locale })
        );
      }
    } catch {
      if (detailRevision.current === revision) {
        setError(m.actionFailedUnexpectedly({}, { locale }));
      }
    } finally {
      beginPending.current = false;
      setBeginning(false);
    }
  };

  const stage = checkoutStages[step.kind];
  const days = formatCount(unlimitedPassDays, locale);
  return (
    <CheckoutFlowLayout
      activeStepKey={stage}
      locale={locale}
      steps={
        <CheckoutSteps
          activeStepKey={stage}
          label={m.unlimitedPassCheckoutSteps({}, { locale })}
          labels={{
            chooseSpace: m.unlimitedPassCheckoutChoose({ days }, { locale }),
            contact: m.unlimitedPassCheckoutHolder({}, { locale }),
          }}
          locale={locale}
          stepLinks={{
            ...(step.kind === "details" &&
              !isBeginning && {
                chooseSpace: { onSelect: () => goToChoose() },
              }),
            ...(step.kind === "pay" &&
              !step.retry &&
              !paymentRequested && {
                contact: {
                  onSelect: () =>
                    goToDetails(step.selection, {
                      kind: "resume",
                      orderId: step.orderId,
                    }),
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
            today={availability.data?.today ?? initialBounds.today}
            lastStartDate={initialBounds.lastStartDate}
            calendarMonth={calendarMonth}
            options={options}
            startDate={startDate}
            availability={calendarAvailability}
            onOptionsChange={updateSelection}
            onMonthChange={setCalendarMonth}
            onStartDateChange={(next) => updateSelection(options, next)}
            onRetry={() => void availability.refetch()}
            onContinue={(selection) => goToDetails(selection, orderLink)}
          />
        </>
      )}
      {step.kind === "details" && (
        <UnlimitedPassDetails
          buyer={buyer}
          locale={locale}
          selection={step.selection}
          initialValues={details}
          draftRef={detailsDraft}
          order={orderLink}
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
          product="unlimited"
          orderLabel={m.unlimitedPassCheckoutOrderLabel(
            { tier: getPassTierName(step.selection.tier, locale) },
            { locale }
          )}
          orderDetail={getOrderDetail(step.selection, locale, days)}
          returnExpiredQuoteToStatus={step.retry === true}
          repriceCheckout={repriceCheckout}
          payCheckout={payCheckout}
          discountCodeEntryEnabled={discountCodeEntryEnabled && !step.retry}
          signInPath={getAccountSignInPath(
            locale,
            step.retry
              ? getUnlimitedPassPayPath(locale, step.orderId)
              : getUnlimitedPassDetailsPath(locale, step.selection, {
                  kind: "resume",
                  orderId: step.orderId,
                })
          )}
          headingRef={heading}
          onRequestPayment={() => setPaymentRequested(true)}
          onExpire={() => {
            attempt.current = undefined;
            setSavedOrderId(undefined);
            setActiveDraftOrderId(undefined);
            setDetails({ ...details, billing: step.state.billing });
            goToDetails(step.selection);
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

function getOrderLink(
  orderId: OrderId | undefined,
  predecessor: OrderId | undefined
): UnlimitedPassOrderLink | undefined {
  if (orderId !== undefined) return { kind: "resume", orderId };
  if (predecessor !== undefined)
    return { kind: "replace", orderId: predecessor };
}
