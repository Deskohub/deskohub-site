"use client";

// PROTOTYPE ONLY (#1361): booking one date with an Entry pack entry, in the
// normal cowork flow look. States (?state=): "free" (pack pays, CZK 0),
// "coffee" (coffee added, only the add-on is paid), "coffee-pay" (pay step for
// the coffee only). Local state only; nothing is booked.
import { Coffee, Info, Lock, Ticket } from "lucide-react";
import { useState } from "react";
import {
  CheckoutPayCard,
  CheckoutPayConsent,
  CheckoutPaySubmitButton,
} from "@/features/checkout/components/checkout-pay-page-card";
import { CheckoutSummaryLine } from "@/features/checkout/components/checkout-summary-line";
import type { Locale } from "@/features/i18n";
import {
  formatCzk,
  formatPrototypeDate,
  SINGLE_DAY_COFFEE_PRICE,
  tierByKey,
} from "@/features/passes/prototype/mock-passes";
import { DateInput } from "@/shared/components/date-time/date-input";
import { Button } from "@/shared/components/ui/button";
import { Checkbox } from "@/shared/components/ui/checkbox";
import type { Money } from "@/shared/money/money";
import { cn } from "@/shared/utils";
import {
  entriesLeft,
  formatWeekdayDate,
  PACK_FOR_BOOKING,
} from "./holder-mock";

export const PACK_BOOKING_STATES = [
  { key: "free", label: "Pack pays · CZK 0" },
  { key: "coffee", label: "Coffee added" },
  { key: "coffee-pay", label: "Pay for coffee" },
] as const;

const czk = (amount: number): Money => ({
  value: amount * 100,
  exponent: 2,
  currency: "CZK",
});

const BOOKED_DATE = "2026-11-19";
const CHOSEN_DATE = "2026-11-20";

function SectionTitle({ children }: { readonly children: string }) {
  return (
    <h2 className="text-sm font-bold uppercase tracking-[0.12em] text-navy-blue/60">
      {children}
    </h2>
  );
}

function Summary({
  coffee,
  locale,
}: {
  readonly coffee: boolean;
  readonly locale: Locale;
}) {
  const pass = PACK_FOR_BOOKING;
  return (
    <div className="rounded-3xl border border-navy-blue/10 bg-[#fbfaf7] p-5">
      <ul className="grid gap-3">
        <CheckoutSummaryLine
          label={
            <span>
              {tierByKey(pass.tier).label} · {formatWeekdayDate(CHOSEN_DATE)}
              <span className="block text-sm font-normal text-navy-blue/60">
                1 entry from your Entry pack · {entriesLeft(pass) - 1} left after this
              </span>
            </span>
          }
          locale={locale}
        >
          <span className="shrink-0 font-semibold tabular-nums">
            {formatCzk(0)}
          </span>
        </CheckoutSummaryLine>
        {coffee && (
          <CheckoutSummaryLine amount={czk(SINGLE_DAY_COFFEE_PRICE)} label="Coffee" locale={locale} />
        )}
      </ul>
      <div className="mt-4 flex items-baseline justify-between gap-4 border-t border-navy-blue/10 pt-4">
        <span className="font-bold">To pay</span>
        <span className="text-2xl font-bold tabular-nums">
          {formatCzk(coffee ? SINGLE_DAY_COFFEE_PRICE : 0)}
        </span>
      </div>
    </div>
  );
}

function NoCancelNote() {
  return (
    <p className="flex items-start gap-3 rounded-2xl bg-sunset-yellow/15 px-4 py-3 text-sm leading-6 text-navy-blue/80">
      <Lock aria-hidden="true" className="mt-1 size-4 shrink-0" />
      <span>
        Days booked with an Entry pack can’t be cancelled or moved. The entry is
        used once you confirm.
      </span>
    </p>
  );
}

function ChooseDay({
  initialCoffee,
  locale,
}: {
  readonly initialCoffee: boolean;
  readonly locale: Locale;
}) {
  const pass = PACK_FOR_BOOKING;
  const tier = tierByKey(pass.tier);
  const [payWith, setPayWith] = useState("pack");
  const [date, setDate] = useState(CHOSEN_DATE);
  const [coffee, setCoffee] = useState(initialCoffee);

  return (
    <CheckoutPayCard
      lead={`Your Entry pack covers one ${tier.label} day per date. Add-ons are paid separately.`}
      title="Book a day"
    >
      <section className="grid gap-3">
        <SectionTitle>Pay with</SectionTitle>
        <div className="grid gap-3" role="radiogroup">
          {[
            {
              key: "pack",
              title: `Entry pack · ${tier.label}`,
              detail: `${entriesLeft(pass)} of ${pass.size} entries left · valid until ${formatPrototypeDate(pass.validUntil)}`,
              price: "1 entry",
            },
            {
              key: "card",
              title: "Pay for this day by card",
              detail: `${tier.label}, single day`,
              price: formatCzk(tier.singleDayPrice),
            },
          ].map((option) => {
            const selected = payWith === option.key;
            return (
              <button
                aria-checked={selected}
                className={cn(
                  "flex min-w-0 items-center gap-4 rounded-2xl border bg-white px-4 py-4 text-left transition-colors",
                  selected
                    ? "border-burned-orange bg-burned-orange/5 ring-1 ring-burned-orange"
                    : "border-navy-blue/12 hover:border-navy-blue/30"
                )}
                key={option.key}
                onClick={() => setPayWith(option.key)}
                role="radio"
                type="button"
              >
                <span
                  className={cn(
                    "grid size-5 shrink-0 place-items-center rounded-full border-2",
                    selected ? "border-burned-orange" : "border-navy-blue/30"
                  )}
                >
                  {selected && <span className="size-2.5 rounded-full bg-burned-orange" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold text-navy-blue">{option.title}</span>
                  <span className="mt-0.5 block text-sm text-navy-blue/65">{option.detail}</span>
                </span>
                <span className="shrink-0 text-sm font-bold uppercase tracking-[0.1em] text-navy-blue">
                  {option.price}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="grid gap-3">
        <SectionTitle>Date</SectionTitle>
        <DateInput
          isDateDisabled={(day) =>
            day.toString() === BOOKED_DATE ||
            day.toString() < "2026-11-17" ||
            day.toString() > pass.validUntil
          }
          label="Date"
          locale={locale}
          onChange={setDate}
          value={date}
        />
        <p className="flex items-start gap-2 text-sm leading-6 text-navy-blue/65">
          <Info aria-hidden="true" className="mt-1 size-4 shrink-0" />
          <span>
            {formatWeekdayDate(BOOKED_DATE)} is already booked with this pack.
            One pack booking per date; any date until{" "}
            {formatPrototypeDate(pass.validUntil)}.
          </span>
        </p>
      </section>

      <section className="grid gap-3">
        <SectionTitle>Add-ons, paid separately</SectionTitle>
        <label
          className={cn(
            "flex cursor-pointer items-center gap-4 rounded-2xl border bg-white px-4 py-4 transition-colors",
            coffee ? "border-burned-orange ring-1 ring-burned-orange" : "border-navy-blue/12"
          )}
        >
          <Checkbox
            checked={coffee}
            onCheckedChange={(value) => setCoffee(value === true)}
          />
          <Coffee aria-hidden="true" className="size-5 shrink-0 text-navy-blue/70" />
          <span className="min-w-0 flex-1 font-semibold">Coffee</span>
          <span className="shrink-0 font-semibold tabular-nums">
            + {formatCzk(SINGLE_DAY_COFFEE_PRICE)}
          </span>
        </label>
      </section>

      <Summary coffee={coffee} locale={locale} />
      <NoCancelNote />

      <Button className="w-full" size="lg">
        {coffee ? (
          `Continue to pay ${formatCzk(SINGLE_DAY_COFFEE_PRICE)}`
        ) : (
          <>
            <Ticket aria-hidden="true" />
            Book with 1 entry
          </>
        )}
      </Button>
    </CheckoutPayCard>
  );
}

function PayForCoffee({ locale }: { readonly locale: Locale }) {
  const [consent, setConsent] = useState(false);
  return (
    <CheckoutPayCard
      lead="Your Entry pack covers the day. You only pay for the coffee."
      title="Pay for your add-on"
    >
      <Summary coffee locale={locale} />
      <NoCancelNote />
      <CheckoutPayConsent
        checked={consent}
        id="prototype-pack-consent"
        locale={locale}
        onCheckedChange={setConsent}
        variant="pay"
      />
      <CheckoutPaySubmitButton
        disabled={!consent}
        locale={locale}
        total={czk(SINGLE_DAY_COFFEE_PRICE)}
        variant="pay"
      />
    </CheckoutPayCard>
  );
}

export function PackBookingCard({
  locale,
  state,
}: {
  readonly locale: Locale;
  readonly state: string;
}) {
  if (state === "coffee-pay") return <PayForCoffee locale={locale} />;
  return <ChooseDay initialCoffee={state === "coffee"} key={state} locale={locale} />;
}
