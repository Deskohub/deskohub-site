// PROTOTYPE ONLY: price page with the new Entry pack and Unlimited sections
// (#1360). Static header props and mock prices; no session reads.

import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { m } from "@/features/i18n";
import { getRequestLocale } from "@/features/i18n/server/request-locale";
import { PricingWithPasses } from "@/features/passes/prototype/purchase/pricing-with-passes";
import { SiteHeader } from "@/shared/components/site-header";
import { getSiteHeaderAccessibilityLabels } from "@/shared/components/site-header-config";
import { createSiteHeaderLinks } from "@/shared/components/site-header-links";

export const metadata: Metadata = {
  title: "Prototype: price page with passes",
  robots: { index: false, follow: false },
};

export default function PricingPassesPrototypePage() {
  return (
    <Suspense fallback={null}>
      <PricingPassesPrototype />
    </Suspense>
  );
}

async function PricingPassesPrototype() {
  await connection();
  const locale = await getRequestLocale();

  return (
    <>
      <SiteHeader
        {...getSiteHeaderAccessibilityLabels(locale)}
        contactHref={`/${locale}/prototype-passes/single-day-link`}
        contactLabel={m.reservationNavCta({}, { locale })}
        currentLocale={locale}
        links={createSiteHeaderLinks(locale)}
      />
      <PricingWithPasses locale={locale} />
    </>
  );
}
