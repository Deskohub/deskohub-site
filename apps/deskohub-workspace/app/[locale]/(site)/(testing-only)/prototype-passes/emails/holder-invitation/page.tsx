// PROTOTYPE ONLY (#1361): holder-invitation email rendered with mock data.
// States: ?product=entry-pack (default) | unlimited
import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { getRequestLocale } from "@/features/i18n/server/request-locale";
import {
  PASS_EMAIL_PRODUCTS,
  PassEmailPreview,
} from "@/features/passes/prototype/holder/emails/pass-email-preview";
import { PrototypeVariantSwitcher } from "@/shared/components/prototype-variant-switcher";

export const metadata: Metadata = {
  title: "Prototype: holder-invitation email",
  robots: { index: false, follow: false },
};

type PageProps = {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default function PrototypeHolderInvitationEmailPage({ searchParams }: PageProps) {
  return (
    <Suspense fallback={null}>
      <Content searchParams={searchParams} />
    </Suspense>
  );
}

async function Content({ searchParams }: PageProps) {
  await connection();
  const [locale, params] = await Promise.all([getRequestLocale(), searchParams]);
  const product = typeof params.product === "string" ? params.product : "entry-pack";

  return (
    <>
      <PassEmailPreview email="holder-invitation" locale={locale} product={product} />
      <PrototypeVariantSwitcher param="product" variants={PASS_EMAIL_PRODUCTS} />
    </>
  );
}
