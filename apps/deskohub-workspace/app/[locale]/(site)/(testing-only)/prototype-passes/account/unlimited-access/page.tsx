// PROTOTYPE ONLY (#1361): Unlimited access page with today's door code.
// States: ?tier=open-space (default) | reserved-desk
import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { getRequestLocale } from "@/features/i18n/server/request-locale";
import { PrototypeSiteHeader } from "@/features/passes/prototype/holder/prototype-site-header";
import {
  UNLIMITED_ACCESS_STATES,
  UnlimitedAccessScreen,
} from "@/features/passes/prototype/holder/unlimited-access-screen";
import { PrototypeVariantSwitcher } from "@/shared/components/prototype-variant-switcher";

export const metadata: Metadata = {
  title: "Prototype: Unlimited access",
  robots: { index: false, follow: false },
};

type PageProps = {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default function PrototypeUnlimitedAccessPage({ searchParams }: PageProps) {
  return (
    <Suspense fallback={null}>
      <Content searchParams={searchParams} />
    </Suspense>
  );
}

async function Content({ searchParams }: PageProps) {
  await connection();
  const [locale, params] = await Promise.all([getRequestLocale(), searchParams]);
  const tier = typeof params.tier === "string" ? params.tier : "open-space";

  return (
    <>
      <PrototypeSiteHeader locale={locale} />
      <UnlimitedAccessScreen locale={locale} tier={tier} />
      <PrototypeVariantSwitcher param="tier" variants={UNLIMITED_ACCESS_STATES} />
    </>
  );
}
