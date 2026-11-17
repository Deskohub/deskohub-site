// PROTOTYPE ONLY: Entry pack purchase flow screens (#1360). Mock data only.
// ?step=choose|holder|pay, ?variant=cards|matrix, plus state params
// (tier, size, holder, email, code, consent) documented in the component.

import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { m } from "@/features/i18n";
import { getRequestLocale } from "@/features/i18n/server/request-locale";
import { EntryPackPurchase } from "@/features/passes/prototype/purchase/entry-pack-purchase";
import { MinimalSiteHeader } from "@/shared/components/minimal-site-header";

export const metadata: Metadata = {
  title: "Prototype: Entry pack purchase",
  robots: { index: false, follow: false },
};

export default function EntryPackPurchasePrototypePage() {
  return (
    <Suspense fallback={null}>
      <EntryPackPurchasePrototype />
    </Suspense>
  );
}

async function EntryPackPurchasePrototype() {
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
      <EntryPackPurchase locale={locale} />
    </>
  );
}
