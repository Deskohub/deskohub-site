"use client";

// PROTOTYPE ONLY: the cowork reservation's first step with a quiet link to
// the pass offers (#1360). No upsell step: the link is the only change.
// Mock prices; nothing here reserves anything.

import { Coffee, Monitor } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { CheckoutFlowLayout } from "@/features/checkout/components/checkout-flow-layout";
import { type Locale, m } from "@/features/i18n";
import { PublicPageBreadcrumbs } from "@/features/public-pages/components/public-page-breadcrumbs";
import { coworkReservationPath } from "@/features/reservation/routes";
import { ReservationFormCard } from "@/features/reservation/components/reservation-form-card";
import {
  ReservationTypeInput,
  ReservationTypeOption,
} from "@/features/reservation/components/reservation-type-input";
import { ReservationSubmitSection } from "@/features/reservation/components/reservation-submit-section";
import { DateInput } from "@/shared/components/date-time/date-input";
import { cn } from "@/shared/utils";
import {
  formatCzk,
  PASS_TIERS,
  PROTOTYPE_TODAY,
  type PassTierKey,
  WORKSTATION_ADDON_PRICE,
} from "../mock-passes";
import { lowestEntryPackDayPrice } from "./purchase-mock";
import {
  AddonToggle,
  FieldLabel,
  PriceSuffix,
  TierArtwork,
  TierDescription,
  TierPerks,
} from "./purchase-ui";

/** Today's single-day coffee add-on (catalog: CZK 50, optional on Open Space). */
const SINGLE_DAY_COFFEE = 50;

export function SingleDayLinkStep({ locale }: { readonly locale: Locale }) {
  const [tier, setTier] = useState<"open-space" | "reserved-desk">(
    "open-space"
  );
  const [date, setDate] = useState("2026-11-18");
  const [coffee, setCoffee] = useState(false);
  const [workstation, setWorkstation] = useState(false);
  const dayTiers = PASS_TIERS.filter((option) => option.key !== "workstation");

  return (
    <CheckoutFlowLayout
      activeStepKey="chooseSpace"
      breadcrumbs={
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
      }
      locale={locale}
    >
      <h1 className="text-4xl leading-tight text-balance sm:text-5xl">
        Book coworking in Palmovka, Prague 8
      </h1>
      <ReservationFormCard>
        <form className="space-y-7" noValidate onSubmit={(e) => e.preventDefault()}>
          <div className="space-y-2">
            <FieldLabel required>
              {m.reservationTierLabel({}, { locale })}
            </FieldLabel>
            <ReservationTypeInput
              aria-required="true"
              idPrefix="reservation-entry-tier"
              onChange={(next) => setTier(next as typeof tier)}
              presentation="illustrated"
              value={tier}
            >
              {dayTiers.map((option) => (
                <ReservationTypeOption
                  key={option.key}
                  illustration={
                    <TierArtwork
                      className={cn(
                        "absolute top-0 right-0 h-auto w-[280%] max-w-[440px] -translate-y-[25%] object-contain object-right-top @min-[400px]/card:translate-x-0",
                        option.key === "open-space"
                          ? "translate-x-[10%]"
                          : "translate-x-[20%]"
                      )}
                      tier={
                        option.key === "reserved-desk" && workstation
                          ? "workstation"
                          : (option.key as PassTierKey)
                      }
                    />
                  }
                  price={
                    <span className="flex items-baseline">
                      {formatCzk(option.singleDayPrice)}
                      <PriceSuffix>
                        {m.coworkReservationPricePeriodSuffix({}, { locale })}
                      </PriceSuffix>
                    </span>
                  }
                  title={option.label}
                  value={option.key}
                >
                  <TierDescription locale={locale} tier={option.key} />
                  <TierPerks context="day" locale={locale} tier={option.key} />
                </ReservationTypeOption>
              ))}
            </ReservationTypeInput>
            {/* The prototype's only change to the real step. */}
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
          </div>

          <div className="grid gap-5 md:grid-cols-2">
            <div className="flex flex-col gap-y-2">
              <FieldLabel required>
                {m.reservationDateLabel({}, { locale })}
              </FieldLabel>
              <DateInput
                label={m.reservationDateLabel({}, { locale })}
                locale={locale}
                minimum={PROTOTYPE_TODAY}
                onChange={setDate}
                value={date}
              />
            </div>
            {tier === "open-space" ? (
              <AddonToggle
                checked={coffee}
                icon={Coffee}
                label={m.reservationCoffeeLabel({}, { locale })}
                onCheckedChange={setCoffee}
                priceLabel={formatCzk(SINGLE_DAY_COFFEE)}
              />
            ) : (
              <AddonToggle
                checked={workstation}
                icon={Monitor}
                label={m.reservationWorkstationLabel({}, { locale })}
                onCheckedChange={setWorkstation}
                priceLabel={formatCzk(WORKSTATION_ADDON_PRICE)}
              />
            )}
          </div>

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
        </form>
      </ReservationFormCard>
    </CheckoutFlowLayout>
  );
}
