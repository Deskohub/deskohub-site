// PROTOTYPE ONLY (#1361): book a date with an Entry pack entry. Mock data only.
// States: ?state=free (default) | coffee | coffee-pay
import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { CheckoutFlowLayout } from "@/features/checkout/components/checkout-flow-layout";
import { getRequestLocale } from "@/features/i18n/server/request-locale";
import {
  PACK_BOOKING_STATES,
  PackBookingCard,
} from "@/features/passes/prototype/holder/pack-booking-screen";
import { MinimalSiteHeader } from "@/shared/components/minimal-site-header";
import { getSiteHeaderAccessibilityLabels } from "@/shared/components/site-header-config";
import { PrototypeVariantSwitcher } from "@/shared/components/prototype-variant-switcher";

export const metadata: Metadata = {
  title: "Prototype: book with an Entry pack",
  robots: { index: false, follow: false },
};

type PageProps = {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default function PrototypePackBookingPage({ searchParams }: PageProps) {
  return (
    <Suspense fallback={null}>
      <Content searchParams={searchParams} />
    </Suspense>
  );
}

async function Content({ searchParams }: PageProps) {
  await connection();
  const [locale, params] = await Promise.all([getRequestLocale(), searchParams]);
  const state = typeof params.state === "string" ? params.state : "free";

  return (
    <>
      <MinimalSiteHeader
        currentLocale={locale}
        languageMenuTriggerLabel={
          getSiteHeaderAccessibilityLabels(locale).languageMenuTriggerLabel
        }
      />
      <CheckoutFlowLayout
        activeStepKey={state === "coffee-pay" ? "pay" : "chooseSpace"}
        breadcrumbs={
          <Link
            className="inline-flex items-center gap-2 text-sm font-semibold text-white/70 hover:text-white"
            href={`/${locale}/prototype-passes/account`}
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
            Passes
          </Link>
        }
        locale={locale}
      >
        <div className="mx-auto w-full max-w-2xl">
          <PackBookingCard locale={locale} state={state} />
        </div>
      </CheckoutFlowLayout>
      <PrototypeVariantSwitcher param="state" variants={PACK_BOOKING_STATES} />
    </>
  );
}
