// PROTOTYPE ONLY: Unlimited purchase flow screens (#1360). Mock data only.
// ?step=choose|holder|pay plus state params
// (tier, start, monitor, coffee, holder, email, code, consent) documented in the component.

import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { m } from "@/features/i18n";
import { getRequestLocale } from "@/features/i18n/server/request-locale";
import { UnlimitedPurchase } from "@/features/passes/prototype/purchase/unlimited-purchase";
import { MinimalSiteHeader } from "@/shared/components/minimal-site-header";

export const metadata: Metadata = {
  title: "Prototype: Unlimited purchase",
  robots: { index: false, follow: false },
};

export default function UnlimitedPurchasePrototypePage() {
  return (
    <Suspense fallback={null}>
      <UnlimitedPurchasePrototype />
    </Suspense>
  );
}

async function UnlimitedPurchasePrototype() {
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
      <UnlimitedPurchase locale={locale} />
    </>
  );
}
