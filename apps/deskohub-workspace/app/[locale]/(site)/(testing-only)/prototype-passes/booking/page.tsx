// PROTOTYPE ONLY (#1392, screen 05 redo): using a pass inside the normal
// /reservation/cowork step. ?state= picks the scenario (see booking-mock.ts).
// Mock data only; nothing is reserved.

import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { m } from "@/features/i18n";
import { getRequestLocale } from "@/features/i18n/server/request-locale";
import { CoworkBookingStep } from "@/features/passes/prototype/booking/cowork-booking-step";
import { MinimalSiteHeader } from "@/shared/components/minimal-site-header";

export const metadata: Metadata = {
  title: "Prototype: booking with a pass",
  robots: { index: false, follow: false },
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default function PassBookingPrototypePage({
  searchParams,
}: {
  readonly searchParams: SearchParams;
}) {
  return (
    <Suspense fallback={null}>
      <PassBookingPrototype searchParams={searchParams} />
    </Suspense>
  );
}

async function PassBookingPrototype({
  searchParams,
}: {
  readonly searchParams: SearchParams;
}) {
  await connection();
  const locale = await getRequestLocale();
  const { state } = await searchParams;

  return (
    <>
      <MinimalSiteHeader
        currentLocale={locale}
        languageMenuTriggerLabel={m.languageMenuTriggerLabel(
          { language: "English" },
          { locale }
        )}
      />
      <CoworkBookingStep
        locale={locale}
        state={typeof state === "string" ? state : "none"}
      />
    </>
  );
}
