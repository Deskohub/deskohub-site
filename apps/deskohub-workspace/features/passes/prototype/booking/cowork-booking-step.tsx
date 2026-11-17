"use client";

// PROTOTYPE ONLY (#1392, screen 05 redo): the normal /reservation/cowork step
// with the pass banner. Using a pass locks what the pass fixes (tier,
// workstation) and leaves the date, monitor setup and coffee editable.
// Lookalike built from the real step's components; mock data only.

import { AlertTriangle, Coffee, Info, Lock, Monitor } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { CheckoutFlowLayout } from "@/features/checkout/components/checkout-flow-layout";
import {
  CheckoutPayCard,
  CheckoutPayConsent,
  CheckoutPaySubmitButton,
} from "@/features/checkout/components/checkout-pay-page-card";
import { CheckoutSummaryLine } from "@/features/checkout/components/checkout-summary-line";
import {
  getWorkspaceProductMessage,
  workspaceProductMonitorDescriptionMessages,
} from "@/features/checkout/product-catalog.i18n";
import { type Locale, m } from "@/features/i18n";
import { PublicPageBreadcrumbs } from "@/features/public-pages/components/public-page-breadcrumbs";
import { ReservationFormCard } from "@/features/reservation/components/reservation-form-card";
import { ReservationSubmitSection } from "@/features/reservation/components/reservation-submit-section";
import {
  ReservationTypeInput,
  ReservationTypeOption,
} from "@/features/reservation/components/reservation-type-input";
import { coworkReservationPath } from "@/features/reservation/routes";
import { DateInput } from "@/shared/components/date-time/date-input";
import { ChoiceCard } from "@/shared/components/ui/choice-card";
import { Label } from "@/shared/components/ui/label";
import { Switch } from "@/shared/components/ui/switch";
import type { Money } from "@/shared/money/money";
import { cn } from "@/shared/utils";
import {
  formatCzk,
  formatPrototypeDate,
  MONITOR_OPTIONS,
  PASS_TIERS,
  PROTOTYPE_TODAY,
  type PassTierKey,
  SINGLE_DAY_COFFEE_PRICE,
  tierByKey,
  WORKSTATION_ADDON_PRICE,
} from "../mock-passes";
import { lowestEntryPackDayPrice } from "../purchase/purchase-mock";
import {
  AddonToggle,
  FieldLabel,
  PriceSuffix,
  TierArtwork,
  TierDescription,
  TierPerks,
} from "../purchase/purchase-ui";
import {
  BOOKING_SCENARIOS,
  type BookingScenario,
  type BookingTier,
  bookingScenario,
  defaultPack,
  type EntryPack,
  lockedTier,
  packCoversDate,
  type UnlimitedPass,
  unlimitedCovers,
  weekdayDate,
} from "./booking-mock";
import {
  PassAppliedBanner,
  PassCoveredBanner,
  PassExpiredBanner,
  PassInvalidLinkNotice,
  PassOfferBanner,
  PassPickerBanner,
  PassSpentBanner,
} from "./pass-banner";

/** A monitor setup already taken on the mock dates. */
const TAKEN_MONITOR = "32-4k";

const czk = (amount: number): Money => ({
  value: amount * 100,
  exponent: 2,
  currency: "CZK",
});

function Breadcrumbs({ locale }: { readonly locale: Locale }) {
  return (
    <PublicPageBreadcrumbs
      crumbs={[
        { pathname: "/coworking", name: m.coworkingBreadcrumb({}, { locale }) },
        {
          pathname: coworkReservationPath,
          name: m.reservationCoworkBreadcrumb({}, { locale }),
        },
      ]}
      locale={locale}
      tone="inverse"
    />
  );
}

function Notice({
  children,
  tone,
}: {
  readonly children: React.ReactNode;
  readonly tone: "warning" | "info" | "lock";
}) {
  const Icon = { warning: AlertTriangle, info: Info, lock: Lock }[tone];
  return (
    <p
      className={cn(
        "flex items-start gap-2 text-sm leading-6",
        tone === "warning"
          ? "rounded-2xl border border-dashed border-sunset-yellow/45 bg-sunset-yellow/14 px-4 py-3 text-navy-blue/70"
          : "text-navy-blue/65"
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "mt-1 h-4 w-4 shrink-0",
          tone === "warning" ? "text-chilean-fire" : "text-burned-orange"
        )}
      />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

export function NoCancelNote() {
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

type SummaryInput = {
  readonly coffee: boolean;
  readonly date: string;
  readonly monitor?: string;
  /** Workstation charged on top of a Reserved Desk entry. */
  readonly paidWorkstation: boolean;
  readonly pack: EntryPack;
};

const summaryTotal = (input: SummaryInput) =>
  (input.coffee ? SINGLE_DAY_COFFEE_PRICE : 0) +
  (input.paidWorkstation ? WORKSTATION_ADDON_PRICE : 0);

const monitorLabel = (key?: string) =>
  MONITOR_OPTIONS.find((option) => option.key === key)?.label;

function BookingSummary({
  input,
  locale,
}: {
  readonly input: SummaryInput;
  readonly locale: Locale;
}) {
  const { pack } = input;
  const included = pack.tier === "workstation";
  return (
    <div
      data-pass-summary
      className="rounded-3xl border border-navy-blue/10 bg-[#fbfaf7] p-5"
    >
      <ul className="grid gap-3">
        <CheckoutSummaryLine
          label={
            <span>
              {
                tierByKey(
                  pack.tier === "workstation" ? "reserved-desk" : pack.tier
                ).label
              }{" "}
              ·{" "}
              <span className="whitespace-nowrap">
                {weekdayDate(input.date)}
              </span>
              <span className="block text-sm font-normal text-navy-blue/60">
                1 entry from your Entry pack
              </span>
            </span>
          }
          locale={locale}
        >
          <span className="shrink-0 font-semibold tabular-nums">
            {formatCzk(0)}
          </span>
        </CheckoutSummaryLine>
        {(included || input.paidWorkstation) && (
          <CheckoutSummaryLine
            label={
              <span>
                Workstation
                <span className="block text-sm font-normal text-navy-blue/60">
                  {monitorLabel(input.monitor)}
                  {included ? " · in your pack" : " · only workstations free"}
                </span>
              </span>
            }
            locale={locale}
          >
            <span className="shrink-0 font-semibold tabular-nums">
              {included ? "Included" : formatCzk(WORKSTATION_ADDON_PRICE)}
            </span>
          </CheckoutSummaryLine>
        )}
        {input.coffee && (
          <CheckoutSummaryLine
            amount={czk(SINGLE_DAY_COFFEE_PRICE)}
            label="Coffee"
            locale={locale}
          />
        )}
      </ul>
      <div className="mt-4 flex items-baseline justify-between gap-4 border-t border-navy-blue/10 pt-4">
        <span className="font-bold">To pay</span>
        <span className="text-2xl font-bold tabular-nums">
          {formatCzk(summaryTotal(input))}
        </span>
      </div>
    </div>
  );
}

function LockedAddonRow({
  checked,
  label,
  reason,
  valueLabel,
}: {
  readonly checked: boolean;
  readonly label: string;
  readonly reason: string;
  readonly valueLabel: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-y-2" data-pass-locked-addon>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <ChoiceCard align="center" className="cursor-default" htmlFor={id}>
        <span className="flex items-center gap-3">
          <Monitor className="h-5 w-5 shrink-0 text-burned-orange" />
          <Switch checked={checked} disabled id={id} />
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-sm font-semibold text-navy-blue">
          <Lock aria-hidden="true" className="size-3.5 text-navy-blue/50" />
          {valueLabel}
        </span>
      </ChoiceCard>
      <p className="text-sm leading-6 text-navy-blue/60">{reason}</p>
    </div>
  );
}

function MonitorOptions({
  locale,
  onChange,
  value,
}: {
  readonly locale: Locale;
  readonly onChange: (value: string) => void;
  readonly value: string;
}) {
  const labelId = useId();
  return (
    <div
      data-cowork-monitor-options
      className="rounded-3xl border border-aquamarine-green/25 bg-aquamarine-green/8 p-4 md:col-span-2"
    >
      <Label id={labelId} className="block pt-1 pb-3 text-sm text-navy-blue/60">
        {m.reservationMonitorLabel({}, { locale })}
      </Label>
      <div
        aria-labelledby={labelId}
        className="grid gap-3 sm:grid-cols-2"
        role="radiogroup"
      >
        {MONITOR_OPTIONS.map((option) => {
          const isSelected = value === option.key;
          const isDisabled = option.key === TAKEN_MONITOR;
          return (
            <label
              key={option.key}
              className={cn(
                "cursor-pointer rounded-[1.1rem] border p-3 transition hover:-translate-y-0.5",
                isDisabled &&
                  "cursor-not-allowed opacity-45 hover:translate-y-0",
                isSelected
                  ? "border-aquamarine-green bg-white ring-4 ring-aquamarine-green/15"
                  : "border-navy-blue/10 bg-white/75 hover:border-aquamarine-green/55"
              )}
            >
              <input
                checked={isSelected}
                className="sr-only"
                disabled={isDisabled}
                name="monitor-setup"
                onChange={() => onChange(option.key)}
                type="radio"
                value={option.key}
              />
              <span className="block font-semibold text-navy-blue">
                {option.label}
              </span>
              <span className="mt-1 block text-sm leading-5 text-navy-blue/60">
                {isDisabled
                  ? "Taken on this date"
                  : getWorkspaceProductMessage(
                      workspaceProductMonitorDescriptionMessages[
                        `2x${option.key}` as keyof typeof workspaceProductMonitorDescriptionMessages
                      ],
                      locale
                    )}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function ChooseSpace({
  locale,
  scenario,
}: {
  readonly locale: Locale;
  readonly scenario: BookingScenario;
}) {
  const packs = scenario.passes.filter(
    (pass): pass is EntryPack => pass.product === "entry-pack"
  );
  const unlimited = scenario.passes.filter(
    (pass): pass is UnlimitedPass => pass.product === "unlimited"
  );
  const [tier, setTier] = useState<BookingTier>(scenario.tier);
  const [date, setDate] = useState(scenario.date);
  const [coffee, setCoffee] = useState(scenario.coffee ?? false);
  const [appliedId, setAppliedId] = useState(
    scenario.spentElsewhere ? undefined : scenario.appliedPassId
  );
  const initialApplied = packs.find((pack) => pack.id === appliedId);
  const [workstation, setWorkstation] = useState(
    scenario.onlyWorkstationFree || initialApplied?.tier === "workstation"
  );
  const [monitor, setMonitor] = useState<string>(MONITOR_OPTIONS[0].key);
  const [pickedId, setPickedId] = useState<string>();
  const [invalidDismissed, setInvalidDismissed] = useState(false);

  const applied = packs.find((pack) => pack.id === appliedId);
  const usablePacks = packs.filter((pack) => packCoversDate(pack, date));
  const covering = unlimited.find((pass) => unlimitedCovers(pass, date));
  const coveringSameTier =
    covering !== undefined && lockedTier(covering) === tier;
  const picked =
    usablePacks.find((pack) => pack.id === pickedId) ??
    defaultPack(usablePacks, tier);
  const expiredPack =
    !applied && usablePacks.length === 0
      ? packs.find((pack) => date > pack.validUntil)
      : undefined;

  const use = (pack: EntryPack) => {
    setAppliedId(pack.id);
    setTier(lockedTier(pack));
    setWorkstation(
      pack.tier === "workstation" || Boolean(scenario.onlyWorkstationFree)
    );
  };

  const workstationOn = workstation || Boolean(scenario.onlyWorkstationFree);
  const dayTiers = PASS_TIERS.filter((option) => option.key !== "workstation");

  let banner: React.ReactNode = null;
  if (applied) {
    banner = (
      <PassAppliedBanner
        onRemove={() => setAppliedId(undefined)}
        pack={applied}
      />
    );
  } else if (scenario.spentElsewhere && packs[0]) {
    banner = <PassSpentBanner date={date} pack={packs[0]} />;
  } else if (covering) {
    banner = (
      <PassCoveredBanner
        date={date}
        locale={locale}
        pass={covering}
        quiet={!coveringSameTier}
      />
    );
  } else if (usablePacks.length > 1 && picked) {
    banner = (
      <PassPickerBanner
        onPick={(pack) => setPickedId(pack.id)}
        onUse={use}
        packs={usablePacks}
        picked={picked}
      />
    );
  } else if (picked) {
    banner = <PassOfferBanner onUse={use} pack={picked} />;
  } else if (expiredPack) {
    banner = (
      <PassExpiredBanner
        date={date}
        onBookLastDay={() => setDate(expiredPack.validUntil)}
        pack={expiredPack}
      />
    );
  }

  const tierLockReason = applied
    ? `Not covered by your Entry pack. To book it, pay by card instead.`
    : undefined;

  return (
    <CheckoutFlowLayout
      activeStepKey="chooseSpace"
      breadcrumbs={<Breadcrumbs locale={locale} />}
      locale={locale}
    >
      <h1 className="text-4xl leading-tight text-balance sm:text-5xl">
        Book coworking in Palmovka, Prague 8
      </h1>
      <div data-pass-booking-card>
        <ReservationFormCard>
          <form
            className="space-y-7"
            data-pass-flow={applied ? "applied" : "card"}
            noValidate
            onSubmit={(event) => event.preventDefault()}
          >
            <div className="space-y-7" data-shot-part="top">
              {scenario.invalidLink && !invalidDismissed && (
                <PassInvalidLinkNotice
                  onDismiss={() => setInvalidDismissed(true)}
                />
              )}
              {banner}

              <div className="space-y-2" data-pass-tier-field>
                <FieldLabel required>
                  {m.reservationTierLabel({}, { locale })}
                </FieldLabel>
                <ReservationTypeInput
                  aria-required="true"
                  idPrefix="reservation-entry-tier"
                  onChange={(next) => setTier(next as BookingTier)}
                  presentation="illustrated"
                  value={tier}
                >
                  {dayTiers.map((option) => {
                    const locked = Boolean(applied) && option.key !== tier;
                    const fromPack = Boolean(applied) && option.key === tier;
                    return (
                      <ReservationTypeOption
                        disabled={locked}
                        key={option.key}
                        illustration={
                          <TierArtwork
                            className={cn(
                              "absolute top-0 right-0 h-auto w-[280%] max-w-[440px] -translate-y-[25%] object-contain object-right-top @min-[400px]/card:translate-x-0",
                              option.key === "open-space"
                                ? "translate-x-[10%]"
                                : "translate-x-[20%]",
                              locked && "opacity-40 grayscale"
                            )}
                            tier={
                              option.key === "reserved-desk" && workstationOn
                                ? "workstation"
                                : (option.key as PassTierKey)
                            }
                          />
                        }
                        price={
                          fromPack ? (
                            <span className="flex items-baseline">
                              1 entry
                              <PriceSuffix>from your pack</PriceSuffix>
                            </span>
                          ) : (
                            <span
                              className={cn(
                                "flex items-baseline",
                                locked && "text-navy-blue/45"
                              )}
                            >
                              {formatCzk(option.singleDayPrice)}
                              <PriceSuffix>
                                {m.coworkReservationPricePeriodSuffix(
                                  {},
                                  { locale }
                                )}
                              </PriceSuffix>
                            </span>
                          )
                        }
                        title={option.label}
                        value={option.key}
                      >
                        {locked ? (
                          <span
                            className="flex items-start gap-2 text-sm leading-6 font-medium text-navy-blue/70"
                            data-pass-locked-tier
                          >
                            <Lock
                              aria-hidden="true"
                              className="mt-1 size-4 shrink-0"
                            />
                            <span className="box-decoration-clone rounded-sm bg-white/85 px-1 py-0.5">
                              {tierLockReason}
                            </span>
                          </span>
                        ) : (
                          <>
                            <TierDescription
                              locale={locale}
                              tier={option.key}
                            />
                            <TierPerks
                              context="day"
                              locale={locale}
                              tier={option.key}
                            />
                          </>
                        )}
                      </ReservationTypeOption>
                    );
                  })}
                </ReservationTypeInput>
                {scenario.passes.length === 0 && (
                  <p
                    data-pass-offer-link
                    className="pt-1 text-sm leading-6 text-navy-blue/60"
                  >
                    Coming often?{" "}
                    <Link
                      className="font-semibold text-navy-blue underline decoration-navy-blue/30 underline-offset-4 transition-colors hover:text-burned-orange hover:decoration-burned-orange"
                      href={`/${locale}/prototype-passes/pricing#pricing-entry-packs`}
                    >
                      Entry packs from{" "}
                      <span className="whitespace-nowrap">
                        {formatCzk(lowestEntryPackDayPrice("open-space"))} a day
                      </span>
                    </Link>
                  </p>
                )}
              </div>
            </div>

            <div className="space-y-7" data-shot-part="bottom">
              <div className="grid gap-5 md:grid-cols-2">
                <div className="flex flex-col gap-y-2">
                  <FieldLabel required>
                    {m.reservationDateLabel({}, { locale })}
                  </FieldLabel>
                  <DateInput
                    isDateDisabled={
                      applied
                        ? (day) => !packCoversDate(applied, day.toString())
                        : undefined
                    }
                    label={m.reservationDateLabel({}, { locale })}
                    locale={locale}
                    minimum={PROTOTYPE_TODAY}
                    onChange={setDate}
                    value={date}
                  />
                  {applied && (
                    <Notice tone="info">
                      Any free date until{" "}
                      {formatPrototypeDate(applied.validUntil)}.
                      {applied.bookedDates.map(
                        (booked) =>
                          ` ${weekdayDate(booked)} is already booked with your pack.`
                      )}
                    </Notice>
                  )}
                  {scenario.onlyWorkstationFree && tier === "reserved-desk" && (
                    <Notice tone="warning">
                      On {weekdayDate(date)} only desks with a workstation are
                      free.{" "}
                      {applied
                        ? `Your pack covers the desk; the workstation costs ${formatCzk(WORKSTATION_ADDON_PRICE)}.`
                        : `The workstation costs ${formatCzk(WORKSTATION_ADDON_PRICE)}.`}
                    </Notice>
                  )}
                </div>
                {tier === "open-space" ? (
                  <AddonToggle
                    checked={coffee}
                    icon={Coffee}
                    label={m.reservationCoffeeLabel({}, { locale })}
                    onCheckedChange={setCoffee}
                    priceLabel={formatCzk(SINGLE_DAY_COFFEE_PRICE)}
                  />
                ) : applied?.tier === "workstation" ? (
                  <LockedAddonRow
                    checked
                    label={m.reservationWorkstationLabel({}, { locale })}
                    reason="Included in your Entry pack."
                    valueLabel="Included"
                  />
                ) : applied && scenario.onlyWorkstationFree ? (
                  <LockedAddonRow
                    checked
                    label={m.reservationWorkstationLabel({}, { locale })}
                    reason="Required on this date."
                    valueLabel={`+${formatCzk(WORKSTATION_ADDON_PRICE)}`}
                  />
                ) : applied ? (
                  <LockedAddonRow
                    checked={false}
                    label={m.reservationWorkstationLabel({}, { locale })}
                    reason="Not part of your Entry pack."
                    valueLabel="Not in pack"
                  />
                ) : (
                  <AddonToggle
                    checked={workstationOn}
                    icon={Monitor}
                    label={m.reservationWorkstationLabel({}, { locale })}
                    onCheckedChange={setWorkstation}
                    priceLabel={formatCzk(WORKSTATION_ADDON_PRICE)}
                  />
                )}
                {tier === "reserved-desk" && workstationOn && (
                  <MonitorOptions
                    locale={locale}
                    onChange={setMonitor}
                    value={monitor}
                  />
                )}
              </div>

              {applied && (
                <div className="space-y-3">
                  <BookingSummary
                    input={{
                      coffee: tier === "open-space" && coffee,
                      date,
                      monitor,
                      pack: applied,
                      paidWorkstation:
                        applied.tier === "reserved-desk" &&
                        Boolean(scenario.onlyWorkstationFree),
                    }}
                    locale={locale}
                  />
                  <NoCancelNote />
                </div>
              )}

              {covering && coveringSameTier && (
                <Notice tone="warning">
                  Your Unlimited pass already covers{" "}
                  {tierByKey(covering.tier).label} on {weekdayDate(date)}. Book
                  a paid day only if it’s for someone else.
                </Notice>
              )}

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
      <ScenarioSwitcher current={scenario.key} locale={locale} />
    </CheckoutFlowLayout>
  );
}

function PayForAddons({
  locale,
  scenario,
}: {
  readonly locale: Locale;
  readonly scenario: BookingScenario;
}) {
  const [consent, setConsent] = useState(false);
  const pack = scenario.passes.find(
    (pass): pass is EntryPack => pass.id === scenario.appliedPassId
  );
  if (!pack) return null;
  const input: SummaryInput = {
    coffee: Boolean(scenario.coffee),
    date: scenario.date,
    pack,
    paidWorkstation: false,
  };
  return (
    <CheckoutFlowLayout
      activeStepKey="pay"
      breadcrumbs={<Breadcrumbs locale={locale} />}
      locale={locale}
    >
      <CheckoutPayCard
        lead="Your Entry pack covers the day. You only pay for the coffee."
        title="Pay for your add-on"
      >
        <BookingSummary input={input} locale={locale} />
        <NoCancelNote />
        <CheckoutPayConsent
          checked={consent}
          id="prototype-pass-day-consent"
          locale={locale}
          onCheckedChange={setConsent}
          variant="pay"
        />
        <CheckoutPaySubmitButton
          disabled={!consent}
          locale={locale}
          total={czk(summaryTotal(input))}
          variant="pay"
        />
      </CheckoutPayCard>
      <ScenarioSwitcher current={scenario.key} locale={locale} />
    </CheckoutFlowLayout>
  );
}

function ScenarioSwitcher({
  current,
  locale,
}: {
  readonly current: string;
  readonly locale: Locale;
}) {
  return (
    <nav
      aria-label="Prototype states"
      className="fixed inset-x-0 bottom-0 z-50 flex gap-2 overflow-x-auto border-t border-navy-blue/10 bg-white/95 px-4 py-2 text-xs"
      data-prototype-switcher
    >
      {BOOKING_SCENARIOS.map((scenario) => (
        <Link
          className={cn(
            "shrink-0 rounded-full border px-3 py-1",
            scenario.key === current
              ? "border-burned-orange bg-burned-orange/10 font-semibold"
              : "border-navy-blue/15"
          )}
          href={`/${locale}/prototype-passes/booking?state=${scenario.key}`}
          key={scenario.key}
        >
          {scenario.label}
        </Link>
      ))}
    </nav>
  );
}

export function CoworkBookingStep({
  locale,
  state,
}: {
  readonly locale: Locale;
  readonly state: string;
}) {
  const scenario = bookingScenario(state);
  return scenario.step === "pay" ? (
    <PayForAddons key={scenario.key} locale={locale} scenario={scenario} />
  ) : (
    <ChooseSpace key={scenario.key} locale={locale} scenario={scenario} />
  );
}
