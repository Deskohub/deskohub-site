"use client";

// PROTOTYPE ONLY: Unlimited purchase flow (#1360), mock data, no backend.
// Steps: ?step=choose|holder|pay. State params: tier, start (ISO date),
// monitor, coffee=1, holder=me|other, email, code, consent=1.
// The buyer's customer discount group (10%) applies without a code, so the
// payment step shows how add-ons stay outside discounts.

import { CalendarDays, Coffee, Ticket } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  CheckoutPayCard,
  CheckoutPayConsent,
  CheckoutPayProviderHandoff,
  CheckoutPaySubmitButton,
} from "@/features/checkout/components/checkout-pay-page-card";
import { CheckoutFlowLayout } from "@/features/checkout/components/checkout-flow-layout";
import type { Locale } from "@/features/i18n";
import { ReservationFormCard } from "@/features/reservation/components/reservation-form-card";
import { ReservationSubmitSection } from "@/features/reservation/components/reservation-submit-section";
import { currencyCZK } from "@/shared/money/currencies";
import { Calendar } from "@/shared/components/ui/calendar";
import {
  formatCzk,
  formatPrototypeDate,
  MONITOR_OPTIONS,
  PROTOTYPE_TODAY,
  type PassTierKey,
  tierByKey,
  UNLIMITED_COFFEE_PRICE,
  UNLIMITED_DAYS,
  UNLIMITED_PRICES,
  unlimitedRefund,
} from "../mock-passes";
import {
  discounted,
  formatShortDate,
  isoToLocalDate,
  localDateToIso,
  PROTOTYPE_CUSTOMER_GROUP,
  PROTOTYPE_DESK,
  PROTOTYPE_DISCOUNT_CODE,
  PROTOTYPE_OTHER_HOLDER,
  UNLIMITED_DEFAULT_START,
  UNLIMITED_UNAVAILABLE_MONITOR,
  unlimitedEnd,
  unlimitedFirstBlockedStart,
  unlimitedFullDate,
  unlimitedStartBlockedBy,
} from "./purchase-mock";
import {
  AddonToggle,
  DiscountCodeField,
  EarlyStartConsent,
  FieldLabel,
  FlowNote,
  MonitorSetupOptions,
  PassCheckoutSteps,
  PassHolderField,
  PassSelectionSummary,
  PassTierOptions,
  PriceSuffix,
  SignedInBuyer,
  SummaryLine,
  SummarySection,
  usePrototypeParams,
} from "./purchase-ui";

const steps = [
  { key: "choose", label: "Choose your 30 days" },
  { key: "holder", label: "Pass holder" },
  { key: "pay", label: "Payment" },
] as const;

type Selection = {
  readonly coffee: boolean;
  readonly monitor: string;
  readonly start: string;
  readonly tier: PassTierKey;
};

const useSelection = (): Selection => {
  const params = usePrototypeParams();
  return {
    coffee: params.get("coffee", "1") === "1",
    monitor: params.get("monitor", "27-qhd"),
    start: params.get("start", UNLIMITED_DEFAULT_START),
    tier: params.get("tier", "reserved-desk") as PassTierKey,
  };
};

const monitorLabel = (key: string) =>
  MONITOR_OPTIONS.find((option) => option.key === key)?.label ?? key;

const hasOwnDesk = (tier: PassTierKey) => tier !== "open-space";

export function UnlimitedPurchase({ locale }: { readonly locale: Locale }) {
  const params = usePrototypeParams();
  const step = params.get("step", "choose");

  return (
    <CheckoutFlowLayout
      activeStepKey="chooseSpace"
      locale={locale}
      steps={
        <PassCheckoutSteps
          activeKey={step}
          hrefFor={(key) => params.hrefWith({ step: key })}
          steps={steps}
        />
      }
    >
      {step !== "pay" && (
        <h1 className="text-4xl leading-tight text-balance sm:text-5xl">
          Buy Unlimited
        </h1>
      )}
      {step === "choose" && <ChooseStep locale={locale} />}
      {step === "holder" && <HolderStep locale={locale} />}
      {step === "pay" && <PayStep locale={locale} />}
    </CheckoutFlowLayout>
  );
}

function ContinueForm({
  children,
  locale,
  next,
}: {
  readonly children: ReactNode;
  readonly locale: Locale;
  readonly next: Record<string, string | undefined>;
}) {
  const params = usePrototypeParams();
  return (
    <div data-shot="flow-card">
    <ReservationFormCard>
      <form
        className="space-y-7"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          params.go(next);
        }}
      >
        {children}
        <div data-shot-part="rest">
        <ReservationSubmitSection
          continues
          disabled={false}
          isAvailabilityLoading={false}
          isPriceLoading={false}
          locale={locale}
          onRetryPrice={() => {}}
          priceError={false}
          retryingPrice={false}
        />
        </div>
      </form>
    </ReservationFormCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1

function ChooseStep({ locale }: { readonly locale: Locale }) {
  const params = usePrototypeParams();
  const selection = useSelection();

  return (
    <ContinueForm locale={locale} next={{ step: "holder" }}>
      <PassTierOptions
        locale={locale}
        onChange={(tier) => params.set({ tier })}
        price={(tier) => (
          <span className="flex items-baseline">
            {formatCzk(UNLIMITED_PRICES[tier])}
            <PriceSuffix>/ 30 days</PriceSuffix>
          </span>
        )}
        value={selection.tier}
      />
      <div className="space-y-7" data-shot-part="rest">
      <StartDateField selection={selection} />
      {selection.tier === "workstation" && (
        <MonitorSetupOptions
          locale={locale}
          onChange={(monitor) => params.set({ monitor })}
          unavailable={UNLIMITED_UNAVAILABLE_MONITOR}
          unavailableReason="Not free on all 30 days"
          value={selection.monitor}
        />
      )}
      <div className="grid gap-5 md:grid-cols-2">
        <AddonToggle
          checked={selection.coffee}
          icon={Coffee}
          label="Coffee for 30 days"
          onCheckedChange={(coffee) => params.set({ coffee: coffee ? "1" : "0" })}
          priceLabel={formatCzk(UNLIMITED_COFFEE_PRICE)}
        >
          <p className="text-sm leading-6 text-navy-blue/60">
            Coffee on every day of your pass. Discounts don't apply to
            add-ons.
          </p>
        </AddonToggle>
      </div>
      </div>
    </ContinueForm>
  );
}

function StartDateField({ selection }: { readonly selection: Selection }) {
  const params = usePrototypeParams();
  const { start, tier } = selection;
  const end = unlimitedEnd(start);
  const today = isoToLocalDate(PROTOTYPE_TODAY);
  const firstBlocked = unlimitedFirstBlockedStart(tier);
  const fullDate = unlimitedFullDate(tier);
  const isBlockedStart = (date: Date) =>
    unlimitedStartBlockedBy(tier, localDateToIso(date)) !== undefined;

  return (
    <div className="space-y-3">
      <FieldLabel required>Start date</FieldLabel>
      <div className="grid gap-4 lg:grid-cols-[auto_minmax(0,1fr)] lg:items-start">
        <div className="relative w-fit max-w-full rounded-3xl border border-navy-blue/10 bg-white p-2 sm:p-3">
          <Calendar
            classNames={{
              root: "relative w-fit text-navy-blue",
              months: "flex flex-col gap-6 md:flex-row",
              nav: "absolute inset-x-2 top-2 z-10 flex items-center justify-between",
            }}
            defaultMonth={today}
            disabled={[{ before: isoToLocalDate(UNLIMITED_DEFAULT_START) }, isBlockedStart]}
            mode="single"
            modifiers={{
              blockedStart: isBlockedStart,
              span: {
                from: isoToLocalDate(start),
                to: isoToLocalDate(end),
              },
            }}
            modifiersClassNames={{
              blockedStart:
                "[&>button]:line-through [&>button]:decoration-navy-blue/50",
              span: "[&>button]:rounded-none [&>button]:bg-aquamarine-green/22 [&>button]:font-semibold [&>button]:opacity-100",
            }}
            numberOfMonths={2}
            onSelect={(date) => {
              if (date) params.set({ start: localDateToIso(date) });
            }}
            selected={isoToLocalDate(start)}
            showOutsideDays={false}
            today={today}
            weekStartsOn={1}
          />
        </div>
        <div className="space-y-4 rounded-3xl border border-aquamarine-green/25 bg-aquamarine-green/8 p-4 sm:p-5">
          <div className="space-y-1">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-navy-blue/55">
              Your 30 days
            </p>
            <p className="text-xl font-semibold text-navy-blue">
              {formatShortDate(start)} – {formatPrototypeDate(end)}
            </p>
            <p className="text-sm leading-6 text-navy-blue/70">
              {hasOwnDesk(tier)
                ? `${PROTOTYPE_DESK} is free on all ${UNLIMITED_DAYS} days and is yours, day and night. No booking needed.`
                : `A desk in the open space on all ${UNLIMITED_DAYS} days, 00:00–17:00. No booking needed.`}
            </p>
          </div>
          <ul className="space-y-2 text-sm leading-6 text-navy-blue/70">
            <li className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="size-4 shrink-0 rounded-sm bg-aquamarine-green/40"
              />
              Your 30 days
            </li>
            <li className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="flex size-4 shrink-0 items-center justify-center text-xs text-navy-blue/50 line-through"
              >
                18
              </span>
              Can't start: not every one of the 30 days is free
            </li>
          </ul>
          {firstBlocked && fullDate && (
            <FlowNote icon={CalendarDays}>
              {hasOwnDesk(tier)
                ? `No desk is free on ${formatPrototypeDate(fullDate)}, so the latest start before it is ${formatShortDate(addDaysIso(firstBlocked, -1))}.`
                : `The open space is full on ${formatPrototypeDate(fullDate)}, so the latest start before it is ${formatShortDate(addDaysIso(firstBlocked, -1))}.`}
            </FlowNote>
          )}
        </div>
      </div>
    </div>
  );
}

const addDaysIso = (isoDate: string, days: number) => {
  const date = isoToLocalDate(isoDate);
  date.setDate(date.getDate() + days);
  return localDateToIso(date);
};

// ---------------------------------------------------------------------------
// Step 2

function HolderStep({ locale }: { readonly locale: Locale }) {
  const params = usePrototypeParams();
  const holder = params.get("holder", "me") === "other" ? "other" : "me";
  const [email, setEmail] = useState(
    params.get("email", holder === "other" ? PROTOTYPE_OTHER_HOLDER.email : "")
  );

  return (
    <ContinueForm
      locale={locale}
      next={{ step: "pay", email: holder === "other" ? email : undefined }}
    >
      <UnlimitedSummary />
      <SignedInBuyer />
      <PassHolderField
        email={email}
        holder={holder}
        onEmailChange={setEmail}
        onHolderChange={(next) => params.set({ holder: next })}
      />
    </ContinueForm>
  );
}

function UnlimitedSummary() {
  const params = usePrototypeParams();
  const { coffee, monitor, start, tier } = useSelection();
  return (
    <PassSelectionSummary
      changeHref={params.hrefWith({ step: "choose" })}
      rows={[
        {
          label: "Dates",
          value: `${formatShortDate(start)} – ${formatPrototypeDate(unlimitedEnd(start))}`,
        },
        {
          label: hasOwnDesk(tier) ? "Desk" : "Workspace",
          value:
            tier === "workstation"
              ? `${PROTOTYPE_DESK}, ${monitorLabel(monitor)}`
              : hasOwnDesk(tier)
                ? PROTOTYPE_DESK
                : "Open Space",
        },
        {
          label: "Price",
          value: formatCzk(
            UNLIMITED_PRICES[tier] + (coffee ? UNLIMITED_COFFEE_PRICE : 0)
          ),
        },
      ]}
      title={`Unlimited, ${tierByKey(tier).label}${coffee ? " + coffee" : ""}`}
    />
  );
}

// ---------------------------------------------------------------------------
// Step 3

function PayStep({ locale }: { readonly locale: Locale }) {
  const params = usePrototypeParams();
  const { coffee, monitor, start, tier } = useSelection();
  const holderEmail =
    params.get("holder", "me") === "other"
      ? params.get("email", PROTOTYPE_OTHER_HOLDER.email)
      : undefined;
  const [code, setCode] = useState(params.get("code", ""));
  const [draft, setDraft] = useState("");
  const [termsConsent, setTermsConsent] = useState(params.has("consent"));
  const [earlyStart, setEarlyStart] = useState(params.has("consent"));

  const price = UNLIMITED_PRICES[tier];
  // GUESS: a code and the customer group don't stack; the better one wins.
  const percent = code
    ? Math.max(PROTOTYPE_DISCOUNT_CODE.percent, PROTOTYPE_CUSTOMER_GROUP.percent)
    : PROTOTYPE_CUSTOMER_GROUP.percent;
  const passTotal = discounted(price, percent);
  const coffeeTotal = coffee ? UNLIMITED_COFFEE_PRICE : 0;
  const total = passTotal + coffeeTotal;
  const exampleDay = 10;

  return (
    <CheckoutPayCard title="Order summary">
      <div className="space-y-3">
        <SummarySection title="Order">
          <SummaryLine
            amount={passTotal}
            detail={
              <>
                {formatShortDate(start)} – {formatPrototypeDate(unlimitedEnd(start))}
                {hasOwnDesk(tier) && ` · ${PROTOTYPE_DESK}`}
                {tier === "workstation" && ` · ${monitorLabel(monitor)}`}
                <span className="block break-words">
                  Holder: {holderEmail ?? "you"}
                </span>
              </>
            }
            discount={
              code
                ? `Code ${code}: −${percent}%`
                : `Customer discount (${PROTOTYPE_CUSTOMER_GROUP.name}): −${percent}%`
            }
            label={`Unlimited, ${tierByKey(tier).label}, ${UNLIMITED_DAYS} days`}
            originalAmount={price}
          />
          {coffee && (
            <SummaryLine
              amount={coffeeTotal}
              detail="Add-on, not discounted"
              label="Coffee for 30 days"
            />
          )}
        </SummarySection>
        <SummarySection title="Total">
          <SummaryLine amount={total} label="To pay" strong />
        </SummarySection>
      </div>

      <DiscountCodeField
        appliedCode={code || undefined}
        appliedLabel={`Code ${code} applied: −${percent}% off the pass`}
        draft={draft}
        onApply={() =>
          setCode(draft.trim().toUpperCase() || PROTOTYPE_DISCOUNT_CODE.code)
        }
        onDraftChange={setDraft}
        onRemove={() => setCode("")}
      />

      <CheckoutPayProviderHandoff locale={locale} />

      <CheckoutPayConsent
        checked={termsConsent}
        id="pass-pay-terms"
        locale={locale}
        onCheckedChange={setTermsConsent}
        variant="pay"
      />

      <EarlyStartConsent
        checked={earlyStart}
        example={
          <>
            For example, if you withdraw on day {exampleDay}, you get{" "}
            <span className="whitespace-nowrap">
              {formatCzk(unlimitedRefund(passTotal, exampleDay))}
            </span>{" "}
            back.
          </>
        }
        onCheckedChange={setEarlyStart}
      >
        I ask for Unlimited to start on {formatPrototypeDate(start)}, within
        the 14-day withdrawal period. If I withdraw before then, I get a full
        refund. From the start date, I get back the paid pass price × days
        left ÷ 30, rounded down to whole CZK; today counts as used.
      </EarlyStartConsent>

      <CheckoutPaySubmitButton
        disabled={!termsConsent || !earlyStart}
        locale={locale}
        total={currencyCZK(total * 100)}
        variant="pay"
      />

      <FlowNote icon={Ticket}>
        No booking needed: your door code shows on your account page each day
        of the pass.
      </FlowNote>
    </CheckoutPayCard>
  );
}
