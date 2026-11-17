// PROTOTYPE ONLY: the /pricing page look with new Entry pack and Unlimited
// sections (#1360). The coworking rows mock today's catalog prices; the
// real page's meeting room and office lists are left out to keep the
// screenshot on the new sections. Nothing here loads data.

import Link from "next/link";
import type { ReactNode } from "react";
import { type Locale, m } from "@/features/i18n";
import { Container } from "@/shared/components/container";
import { Button } from "@/shared/components/ui/button";
import { formatMoney } from "@/shared/money/money";
import { currencyCZK } from "@/shared/money/currencies";
import {
  ENTRY_PACK_PRICES,
  ENTRY_PACK_VALIDITY_MONTHS,
  entryPackPricePerEntry,
  PASS_TIERS,
  type PassTierKey,
  UNLIMITED_COFFEE_PRICE,
  UNLIMITED_DAYS,
  UNLIMITED_PRICES,
  WORKSTATION_ADDON_PRICE,
} from "../mock-passes";
import { ENTRY_PACK_SIZES } from "./purchase-mock";

const unlimitedTierNotes: Record<PassTierKey, string> = {
  "open-space": "A desk in the open space every day, 00:00–17:00.",
  "reserved-desk": "The same desk is yours on all 30 days, around the clock.",
  workstation:
    "The same desk with two monitors on all 30 days, around the clock.",
};

export function PricingWithPasses({ locale }: { readonly locale: Locale }) {
  const czk = (amount: number) => formatMoney(currencyCZK(amount * 100), locale);

  return (
    <main className="min-h-dvh overflow-x-clip bg-[linear-gradient(180deg,#05083f_0%,#0d1258_45%,#15123e_100%)] pb-20 pt-[calc(var(--site-header-height)+4rem)] text-white sm:pb-24 sm:pt-[calc(var(--site-header-height)+5rem)]">
      <Container className="max-w-4xl">
        <h1 className="text-4xl leading-tight text-balance sm:text-5xl">
          {m.pricingPageTitle({}, { locale })}
        </h1>
        <p className="mt-4 text-lg leading-8 text-white/76">
          {m.pricingIntro({}, { locale })}
        </p>

        <div data-shot="coworking-and-passes">
          <PriceSection id="pricing-cowork" title={m.pricingCoworkTitle({}, { locale })}>
            <PriceRow
              extras={[
                m.pricingAddOnPrice(
                  { name: m.reservationCoffeeLabel({}, { locale }), price: czk(50) },
                  { locale }
                ),
              ]}
              href={`/${locale}/prototype-passes/single-day-link`}
              name="Open Space"
              price={m.pricingPerDay({ price: czk(290) }, { locale })}
            />
            <PriceRow
              extras={[
                m.pricingAddOnIncluded(
                  { name: m.reservationCoffeeLabel({}, { locale }) },
                  { locale }
                ),
                m.pricingAddOnPrice(
                  {
                    name: m.reservationWorkstationLabel({}, { locale }),
                    price: czk(WORKSTATION_ADDON_PRICE),
                  },
                  { locale }
                ),
              ]}
              href={`/${locale}/prototype-passes/single-day-link`}
              name="Reserved Desk"
              price={m.pricingPerDay({ price: czk(410) }, { locale })}
            />
          </PriceSection>

          <PriceSection
            id="pricing-entry-packs"
            lead="5 or 10 days of coworking to use whenever you like before the pack expires. Book each day in the usual reservation flow. You can buy a pack for someone else."
            title="Entry packs"
          >
            {PASS_TIERS.map((tier) => (
              <li
                key={tier.key}
                className="grid gap-4 py-6 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-8"
              >
                <div className="min-w-0">
                  <h3 className="text-xl font-semibold">{tier.label}</h3>
                  <p className="mt-2 text-base leading-7 text-white/76">
                    {tier.description}
                  </p>
                  <ul className="mt-3 grid gap-1 text-base leading-7 text-white/86">
                    {ENTRY_PACK_SIZES.map((size) => (
                      <li key={size}>
                        {size} entries: valid {ENTRY_PACK_VALIDITY_MONTHS[size]}{" "}
                        months
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="flex flex-col items-start gap-3 sm:items-end sm:text-right">
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-1 sm:gap-x-8">
                    {ENTRY_PACK_SIZES.map((size) => (
                      <div key={size} className="min-w-0">
                        <dt className="text-sm leading-6 text-white/76">
                          {size} entries
                        </dt>
                        <dd className="text-2xl font-semibold text-sunset-yellow">
                          {czk(ENTRY_PACK_PRICES[tier.key][size])}
                        </dd>
                        <dd className="text-sm leading-6 text-white/76">
                          {czk(entryPackPricePerEntry(tier.key, size))} a day
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <Button asChild size="md" caps>
                    <Link
                      aria-label={`Buy an entry pack: ${tier.label}`}
                      href={`/${locale}/prototype-passes/entry-pack?tier=${tier.key}`}
                    >
                      Buy
                    </Link>
                  </Button>
                </div>
              </li>
            ))}
          </PriceSection>

          <PriceSection
            id="pricing-unlimited"
            lead={`${UNLIMITED_DAYS} days in a row from the start date you choose. Nothing to book: your door code is ready each day. Paid once, no automatic renewal.`}
            title="Unlimited"
          >
            {PASS_TIERS.map((tier) => (
              <PriceRow
                key={tier.key}
                buyLabel={`Buy Unlimited: ${tier.label}`}
                extras={[
                  `Coffee for 30 days: +${czk(UNLIMITED_COFFEE_PRICE)}`,
                ]}
                href={`/${locale}/prototype-passes/unlimited?tier=${tier.key}`}
                linkText="Buy"
                name={tier.label}
                note={unlimitedTierNotes[tier.key]}
                price={`${czk(UNLIMITED_PRICES[tier.key])} / 30 days`}
                subPrice={`About ${czk(Math.round(UNLIMITED_PRICES[tier.key] / UNLIMITED_DAYS))} a day`}
              />
            ))}
          </PriceSection>
        </div>

        <section aria-labelledby="pricing-address-title" className="mt-14">
          <h2 id="pricing-address-title" className="text-2xl sm:text-3xl">
            {m.contactAddressLabel({}, { locale })}
          </h2>
          <p className="mt-5 text-base leading-7 text-white/60">
            (Address and contact link as on the real page.)
          </p>
        </section>
      </Container>
    </main>
  );
}

function PriceSection({
  children,
  id,
  lead,
  title,
}: {
  readonly children: ReactNode;
  readonly id: string;
  readonly lead?: string;
  readonly title: string;
}) {
  return (
    <section aria-labelledby={`${id}-title`} className="mt-14" id={id}>
      <h2 id={`${id}-title`} className="text-2xl sm:text-3xl">
        {title}
      </h2>
      {lead && <p className="mt-3 text-base leading-7 text-white/76">{lead}</p>}
      <ul className="mt-5 divide-y divide-white/14 border-y border-white/14">
        {children}
      </ul>
    </section>
  );
}

function PriceRow({
  buyLabel,
  extras,
  href,
  linkText = "Reserve",
  name,
  note,
  price,
  subPrice,
}: {
  readonly buyLabel?: string;
  readonly extras: readonly string[];
  readonly href: string;
  readonly linkText?: string;
  readonly name: string;
  readonly note?: string;
  readonly price: string;
  readonly subPrice?: string;
}) {
  return (
    <li className="grid gap-4 py-6 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-8">
      <div className="min-w-0">
        <h3 className="text-xl font-semibold first-letter:uppercase">{name}</h3>
        {note && <p className="mt-2 text-base leading-7 text-white/76">{note}</p>}
        {extras.length > 0 && (
          <ul className="mt-3 grid gap-1 text-base leading-7 text-white/86">
            {extras.map((extra) => (
              <li key={extra}>{extra}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-col items-start gap-3 sm:items-end sm:text-right">
        <div>
          <p className="text-2xl font-semibold text-sunset-yellow">{price}</p>
          {subPrice && (
            <p className="text-sm leading-6 text-white/76">{subPrice}</p>
          )}
        </div>
        <Button asChild size="md" caps>
          <Link aria-label={buyLabel} href={href}>
            {linkText}
          </Link>
        </Button>
      </div>
    </li>
  );
}
