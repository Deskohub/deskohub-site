"use client";

// PROTOTYPE ONLY: Entry pack purchase flow (#1360), mock data, no backend.
// Steps follow the reservation flow: choose → holder → payment, in the URL
// as ?step=choose|holder|pay. Variant (?variant=): "cards" picks the tier
// and the size with two card groups like the reservation flow; "matrix"
// picks one of the six offers from a tier × size grid.
// State params: tier, size, holder=me|other, email, code, consent=1.

import { Ticket } from "lucide-react";
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
import {
  ReservationTypeInput,
  ReservationTypeOption,
} from "@/features/reservation/components/reservation-type-input";
import { ReservationSubmitSection } from "@/features/reservation/components/reservation-submit-section";
import { PrototypeVariantSwitcher } from "@/shared/components/prototype-variant-switcher";
import { currencyCZK } from "@/shared/money/currencies";
import { cn } from "@/shared/utils";
import {
  ENTRY_PACK_PRICES,
  ENTRY_PACK_VALIDITY_MONTHS,
  type EntryPackSize,
  entryPackPricePerEntry,
  entryPackRefund,
  entryPackSavingPerEntry,
  formatCzk,
  formatPrototypeDate,
  PASS_TIERS,
  PROTOTYPE_TODAY,
  type PassTierKey,
  tierByKey,
} from "../mock-passes";
import {
  discounted,
  ENTRY_PACK_SIZES,
  entryPackValidUntil,
  lowestEntryPackDayPrice,
  PROTOTYPE_DISCOUNT_CODE,
  PROTOTYPE_OTHER_HOLDER,
} from "./purchase-mock";
import {
  DiscountCodeField,
  EarlyStartConsent,
  FieldLabel,
  FlowNote,
  PassCheckoutSteps,
  PassHolderField,
  PassSelectionSummary,
  PassTierOptions,
  PriceSuffix,
  SignedInBuyer,
  SummaryLine,
  SummarySection,
  TierArtwork,
  usePrototypeParams,
} from "./purchase-ui";

const steps = [
  { key: "choose", label: "Choose your pack" },
  { key: "holder", label: "Pass holder" },
  { key: "pay", label: "Payment" },
] as const;

const variants = [
  { key: "cards", label: "Tier cards + size cards" },
  { key: "matrix", label: "Tier × size grid" },
] as const;

export function EntryPackPurchase({ locale }: { readonly locale: Locale }) {
  const params = usePrototypeParams();
  const step = params.get("step", "choose");
  const tier = params.get("tier", "reserved-desk") as PassTierKey;
  const size = Number(params.get("size", "10")) as EntryPackSize;

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
          Buy an entry pack
        </h1>
      )}
      {step === "choose" && <ChooseStep size={size} tier={tier} locale={locale} />}
      {step === "holder" && <HolderStep size={size} tier={tier} locale={locale} />}
      {step === "pay" && <PayStep size={size} tier={tier} locale={locale} />}
      <PrototypeVariantSwitcher variants={variants} />
    </CheckoutFlowLayout>
  );
}

type StepProps = {
  readonly locale: Locale;
  readonly size: EntryPackSize;
  readonly tier: PassTierKey;
};

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

function ChooseStep({ locale, size, tier }: StepProps) {
  const params = usePrototypeParams();
  const variant = params.get("variant", "cards");

  return (
    <ContinueForm locale={locale} next={{ step: "holder" }}>
      {variant === "matrix" ? (
        <OfferMatrix
          onChange={(nextTier, nextSize) =>
            params.set({ tier: nextTier, size: String(nextSize) })
          }
          size={size}
          tier={tier}
        />
      ) : (
        <>
          <PassTierOptions
            locale={locale}
            onChange={(nextTier) => params.set({ tier: nextTier })}
            price={(optionTier) => (
              <span className="flex items-baseline">
                <span className="mr-1 text-sm font-normal normal-case tracking-normal text-navy-blue/60">
                  from
                </span>
                {formatCzk(lowestEntryPackDayPrice(optionTier))}
                <PriceSuffix>/ day</PriceSuffix>
              </span>
            )}
            value={tier}
          />
          <div data-shot-part="rest">
            <PackSizeOptions
              onChange={(nextSize) => params.set({ size: String(nextSize) })}
              size={size}
              tier={tier}
            />
          </div>
        </>
      )}
      <div data-shot-part="rest">
        <FlowNote icon={Ticket}>
          One entry is one day. Book each day in the usual reservation flow,
          one entry per date, any time before the pack expires.
        </FlowNote>
      </div>
    </ContinueForm>
  );
}

function PackSizeOptions({
  onChange,
  size,
  tier,
}: {
  readonly onChange: (size: EntryPackSize) => void;
  readonly size: EntryPackSize;
  readonly tier: PassTierKey;
}) {
  return (
    <div className="space-y-2">
      <FieldLabel required>Pack size, {tierByKey(tier).label}</FieldLabel>
      <ReservationTypeInput
        aria-required="true"
        className="lg:grid-cols-2"
        idPrefix="pack-size"
        onChange={(value) => onChange(Number(value) as EntryPackSize)}
        value={String(size)}
      >
        {ENTRY_PACK_SIZES.map((option) => (
          <ReservationTypeOption
            key={option}
            price={
              <span className="text-xl normal-case tracking-normal">
                {formatCzk(ENTRY_PACK_PRICES[tier][option])}
              </span>
            }
            title={`${option} entries`}
            value={String(option)}
          >
            <span className="text-sm leading-6 text-navy-blue/70">
              Valid {ENTRY_PACK_VALIDITY_MONTHS[option]} months, until{" "}
              {formatPrototypeDate(entryPackValidUntil(option))}
            </span>
            <span className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm leading-6">
              <span className="font-semibold text-navy-blue">
                {formatCzk(entryPackPricePerEntry(tier, option))} a day
              </span>
              <SavingBadge saving={entryPackSavingPerEntry(tier, option)} />
            </span>
          </ReservationTypeOption>
        ))}
      </ReservationTypeInput>
    </div>
  );
}

function SavingBadge({ saving }: { readonly saving: number }) {
  return (
    <span className="rounded-full bg-aquamarine-green/15 px-2.5 py-0.5 text-xs font-semibold text-aquamarine-ink">
      {formatCzk(saving)} less than a single day
    </span>
  );
}

function OfferMatrix({
  onChange,
  size,
  tier,
}: {
  readonly onChange: (tier: PassTierKey, size: EntryPackSize) => void;
  readonly size: EntryPackSize;
  readonly tier: PassTierKey;
}) {
  return (
    <div className="space-y-3">
      <FieldLabel required>Choose your pack</FieldLabel>
      <div role="radiogroup" aria-label="Entry pack" className="space-y-3">
        <div
          aria-hidden="true"
          className="hidden gap-3 px-1 text-xs font-semibold uppercase tracking-[0.14em] text-navy-blue/55 md:grid md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)]"
        >
          <span />
          {ENTRY_PACK_SIZES.map((option) => (
            <span key={option}>
              {option} entries · valid {ENTRY_PACK_VALIDITY_MONTHS[option]} months
            </span>
          ))}
        </div>
        {PASS_TIERS.map((rowTier) => (
          <div
            key={rowTier.key}
            className="grid gap-3 rounded-[1.4rem] border border-navy-blue/10 bg-navy-blue/2.5 p-3 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)] md:items-stretch"
          >
            <div className="flex items-center gap-3 px-1">
              <div className="relative h-14 w-20 shrink-0 overflow-hidden rounded-xl bg-white">
                <TierArtwork
                  className="absolute inset-0 h-full w-full object-cover object-right-top"
                  tier={rowTier.key}
                />
              </div>
              <div className="min-w-0">
                <p className="font-semibold leading-6 text-navy-blue">
                  {rowTier.label}
                </p>
                <p className="text-sm leading-5 text-navy-blue/60">
                  Single day {formatCzk(rowTier.singleDayPrice)}
                </p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 md:contents">
              {ENTRY_PACK_SIZES.map((option) => {
                const isSelected = rowTier.key === tier && option === size;
                return (
                  <label
                    key={option}
                    className={cn(
                      "cursor-pointer rounded-[1.1rem] p-3 outline -outline-offset-1 outline-1 transition hover:-translate-y-0.5",
                      isSelected
                        ? "bg-burned-orange/8 outline-burned-orange ring-4 ring-burned-orange/10"
                        : "bg-white outline-navy-blue/10 hover:outline-burned-orange/45"
                    )}
                  >
                    <input
                      checked={isSelected}
                      className="sr-only"
                      name="entry-pack-offer"
                      onChange={() => onChange(rowTier.key, option)}
                      type="radio"
                    />
                    <span className="flex items-start justify-between gap-2">
                      <span className="whitespace-nowrap text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-navy-blue/60 md:sr-only">
                        {option} entries
                      </span>
                      <span
                        aria-hidden="true"
                        className={cn(
                          "mt-0.5 h-4 w-4 shrink-0 rounded-full border transition md:order-last md:ml-auto",
                          isSelected
                            ? "border-burned-orange bg-burned-orange shadow-[inset_0_0_0_4px_white]"
                            : "border-navy-blue/25"
                        )}
                      />
                    </span>
                    <span className="mt-1 block text-xl font-semibold text-navy-blue md:mt-0">
                      {formatCzk(ENTRY_PACK_PRICES[rowTier.key][option])}
                    </span>
                    <span className="block text-sm leading-6 text-navy-blue/70">
                      {formatCzk(entryPackPricePerEntry(rowTier.key, option))} a
                      day
                    </span>
                    <span className="block text-sm leading-6 font-semibold text-aquamarine-ink">
                      −{formatCzk(entryPackSavingPerEntry(rowTier.key, option))}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <p className="text-sm leading-6 text-navy-blue/60 md:hidden">
        Valid 2 months for 5 entries, 3 months for 10. Green is what you save
        each day against a single day.
      </p>
      <p className="hidden text-sm leading-6 text-navy-blue/60 md:block">
        Green is what you save each day against a single day.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2

function HolderStep({ locale, size, tier }: StepProps) {
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
      <PackSummary size={size} tier={tier} />
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

function PackSummary({ size, tier }: Omit<StepProps, "locale">) {
  const params = usePrototypeParams();
  return (
    <PassSelectionSummary
      changeHref={params.hrefWith({ step: "choose" })}
      rows={[
        { label: "Workspace", value: tierByKey(tier).label },
        {
          label: "Valid until",
          value: formatPrototypeDate(entryPackValidUntil(size)),
        },
        { label: "Price", value: formatCzk(ENTRY_PACK_PRICES[tier][size]) },
      ]}
      title={`Entry pack, ${size} entries`}
    />
  );
}

// ---------------------------------------------------------------------------
// Step 3

function PayStep({ locale, size, tier }: StepProps) {
  const params = usePrototypeParams();
  const holderEmail =
    params.get("holder", "me") === "other"
      ? params.get("email", PROTOTYPE_OTHER_HOLDER.email)
      : undefined;
  const [code, setCode] = useState(params.get("code", ""));
  const [draft, setDraft] = useState("");
  const [termsConsent, setTermsConsent] = useState(params.has("consent"));
  const [earlyStart, setEarlyStart] = useState(params.has("consent"));
  const price = ENTRY_PACK_PRICES[tier][size];
  const total = code ? discounted(price, PROTOTYPE_DISCOUNT_CODE.percent) : price;
  const usedExample = Math.min(3, size - 1);

  return (
    <CheckoutPayCard title="Order summary">
      <div className="space-y-3">
        <SummarySection title="Order">
          <SummaryLine
            amount={total}
            detail={
              <>
                {formatPrototypeDate(PROTOTYPE_TODAY)} –{" "}
                {formatPrototypeDate(entryPackValidUntil(size))}
                <span className="block break-words">
                  Holder: {holderEmail ?? "you"}
                </span>
              </>
            }
            discount={
              code
                ? `Code ${code}: −${PROTOTYPE_DISCOUNT_CODE.percent}%`
                : undefined
            }
            label={`Entry pack, ${tierByKey(tier).label}, ${size} entries`}
            originalAmount={code ? price : undefined}
          />
        </SummarySection>
        <SummarySection title="Total">
          <SummaryLine amount={total} label="To pay" strong />
        </SummarySection>
      </div>

      <DiscountCodeField
        appliedCode={code || undefined}
        appliedLabel={`Code ${code} applied: −${PROTOTYPE_DISCOUNT_CODE.percent}% off the pack`}
        draft={draft}
        onApply={() => setCode(draft.trim().toUpperCase() || PROTOTYPE_DISCOUNT_CODE.code)}
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
            For example, if you withdraw after using {usedExample} of{" "}
            {size} entries, you get <span className="whitespace-nowrap">
              {formatCzk(entryPackRefund(total, size - usedExample, size))}
            </span>{" "}
            back.
          </>
        }
        onCheckedChange={setEarlyStart}
      >
        I ask for my entry pack to start now, within the 14-day withdrawal
        period. If I withdraw, I get back what I paid for the unused entries
        (paid price × unused entries ÷ {size}, rounded down to whole CZK). A
        day already booked for today counts as used.
      </EarlyStartConsent>

      <CheckoutPaySubmitButton
        disabled={!termsConsent || !earlyStart}
        locale={locale}
        total={currencyCZK(total * 100)}
        variant="pay"
      />
    </CheckoutPayCard>
  );
}
