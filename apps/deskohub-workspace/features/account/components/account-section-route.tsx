import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { loadAccountPassSection } from "@/features/account/account-pass-section.server";
import { AccountContentLoading } from "@/features/account/components/account-loading";
import { AccountPage } from "@/features/account/components/account-page";
import { AccountSignInRedirect } from "@/features/account/components/account-sign-in-redirect";
import { AccountUnlimitedRenewalUnavailable } from "@/features/account/components/account-unlimited-pass";
import { loadCustomerInvoiceHistory } from "@/features/account/invoice-history.server";
import { loadCustomerAccountPage } from "@/features/account/page-data.server";
import { getAccountPageTitle } from "@/features/account/page-title";
import {
  findAccountSectionOfPathname,
  getAccountSectionPath,
} from "@/features/account/routes";
import {
  isAccountPageSection,
  isAccountSectionReleased,
} from "@/features/account/sections";
import { arePasskeysEnabled } from "@/features/account/server/account-release-gates.server";
import { type Locale, m } from "@/features/i18n";
import { getRequestLocale } from "@/features/i18n/server/request-locale";
import { isCoworkPassesPageOpenAfterConnection } from "@/features/passes/backend/cowork-passes-release-gate.server";
import { areReferralsEnabled } from "@/features/referrals/referral-release-gate.server";
import { getRequestPathname } from "@/shared/backend/utils/request-pathname";

export function getAccountSectionMetadata(
  locale: Locale,
  section: string
): Metadata {
  if (!isAccountPageSection(section)) notFound();

  return {
    title: getAccountPageTitle(locale, section),
    description: m.accountMetadataDescription({}, { locale }),
    robots: { index: false, follow: false },
  };
}

/**
 * The account page: every section, which the account layout's navigation
 * switches between in place by replacing the URL. The sections' route-group
 * layout renders it for the bare account path and every section's path, so a
 * Server Action or refresh after an in-place switch keeps it mounted, with its
 * open dialogs and drafts: it re-renders the switched path's route, and only
 * the section paths' own pages differ.
 *
 * The layout receives no section param, so it checks the requested path's
 * section itself before loading the account: an unknown or withheld section is
 * not found before any account content, or the signed-out redirect to sign-in,
 * renders.
 */
export function AccountSections({ locale }: { readonly locale: Locale }) {
  return (
    <Suspense fallback={<AccountContentLoading locale={locale} />}>
      <AccountSectionsContent locale={locale} />
    </Suspense>
  );
}

async function AccountSectionsContent({ locale }: { readonly locale: Locale }) {
  await connection();
  const pathname = await getRequestPathname();
  const section =
    pathname === undefined
      ? undefined
      : findAccountSectionOfPathname(locale, pathname);
  const purchasesEnabled = await checkAccountSectionRelease(section);
  const [state, { loadPasses, unlimitedPasses }] = await Promise.all([
    loadCustomerAccountPage(),
    loadAccountPassSection(locale, purchasesEnabled),
  ]);
  if (section === "passes") {
    if (state.kind === "unauthenticated") {
      return (
        <AccountSignInRedirect
          locale={locale}
          returnTo={getAccountSectionPath(locale, "passes")}
        />
      );
    }
    if (state.kind === "unavailable") {
      return <AccountUnlimitedRenewalUnavailable locale={locale} />;
    }
    if (!loadPasses) notFound();
  }

  return (
    <AccountPage
      loadInvoiceHistory={() => loadCustomerInvoiceHistory(locale)}
      loadPasses={loadPasses}
      locale={locale}
      passPurchasesEnabled={purchasesEnabled}
      state={state}
      unlimitedPasses={unlimitedPasses}
    />
  );
}

/**
 * A section path's own page, which renders nothing besides the sections'
 * layout: an unknown or unreleased section is not found. The layout checks the
 * same on every render; this check covers a client navigation, which renders
 * the page without the already rendered layout.
 */
export function AccountSectionPathCheck({
  section,
}: {
  readonly section: Promise<string>;
}) {
  return (
    <Suspense fallback={null}>
      <AccountSectionPathCheckContent section={section} />
    </Suspense>
  );
}

async function AccountSectionPathCheckContent({
  section,
}: {
  readonly section: Promise<string>;
}) {
  await connection();
  const name = await section;
  const purchasesEnabled = await checkAccountSectionRelease(name);
  if (name === "passes" && !purchasesEnabled) {
    const state = await loadCustomerAccountPage();
    if (state.kind !== "unauthenticated" && state.kind !== "unavailable") {
      const { loadPasses } = await loadAccountPassSection(
        await getRequestLocale(),
        false
      );
      if (!loadPasses) notFound();
    }
  }

  return null;
}

async function checkAccountSectionRelease(section: string | undefined) {
  if (section === undefined || !isAccountPageSection(section)) notFound();
  const [passkeysEnabled, referralsEnabled, passesEnabled] = await Promise.all([
    arePasskeysEnabled(),
    areReferralsEnabled(),
    isCoworkPassesPageOpenAfterConnection(),
  ]);
  if (
    section !== "passes" &&
    !isAccountSectionReleased(section, {
      passkeysEnabled,
      referralsEnabled,
    })
  ) {
    notFound();
  }
  return passesEnabled;
}
