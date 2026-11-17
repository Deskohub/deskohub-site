// PROTOTYPE ONLY (#1361): holder account page listing passes. Mock data only.
// Variants: ?variant=section (default) | in-reservations
import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { getRequestLocale } from "@/features/i18n/server/request-locale";
import {
  HOLDER_ACCOUNT_VARIANTS,
  HolderAccountScreen,
} from "@/features/passes/prototype/holder/holder-account-screen";
import { PrototypeSiteHeader } from "@/features/passes/prototype/holder/prototype-site-header";
import { PrototypeVariantSwitcher } from "@/shared/components/prototype-variant-switcher";

export const metadata: Metadata = {
  title: "Prototype: account passes",
  robots: { index: false, follow: false },
};

type PageProps = {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default function PrototypeHolderAccountPage({ searchParams }: PageProps) {
  return (
    <Suspense fallback={null}>
      <Content searchParams={searchParams} />
    </Suspense>
  );
}

async function Content({ searchParams }: PageProps) {
  await connection();
  const [locale, params] = await Promise.all([getRequestLocale(), searchParams]);
  const variant = typeof params.variant === "string" ? params.variant : "section";

  return (
    <>
      <PrototypeSiteHeader locale={locale} />
      <HolderAccountScreen locale={locale} variant={variant} />
      <PrototypeVariantSwitcher variants={HOLDER_ACCOUNT_VARIANTS} />
    </>
  );
}
