// PROTOTYPE ONLY: single-day cowork step with the quiet pass link (#1360).
// The real step lives at /reservation/cowork; this is a mock-prop lookalike.
// No upsell step.

import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { m } from "@/features/i18n";
import { getRequestLocale } from "@/features/i18n/server/request-locale";
import { SingleDayLinkStep } from "@/features/passes/prototype/purchase/single-day-link-step";
import { MinimalSiteHeader } from "@/shared/components/minimal-site-header";

export const metadata: Metadata = {
  title: "Prototype: single-day pass link",
  robots: { index: false, follow: false },
};

export default function SingleDayLinkPrototypePage() {
  return (
    <Suspense fallback={null}>
      <SingleDayLinkPrototype />
    </Suspense>
  );
}

async function SingleDayLinkPrototype() {
  await connection();
  const locale = await getRequestLocale();

  return (
    <>
      <MinimalSiteHeader
        currentLocale={locale}
        languageMenuTriggerLabel={m.languageMenuTriggerLabel(
          { language: "English" },
          { locale }
        )}
      />
      <SingleDayLinkStep locale={locale} />
    </>
  );
}
