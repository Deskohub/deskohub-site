// PROTOTYPE ONLY (#1361): the real SiteHeader with static, signed-in props,
// so prototype pages avoid the session-reading (full-header) layout.
import {
  getAccountPath,
  getAccountSignInPath,
} from "@/features/account/routes";
import { type Locale, m } from "@/features/i18n";
import { getCoworkReservationPath } from "@/features/reservation/routes";
import { SiteHeader } from "@/shared/components/site-header";
import { getSiteHeaderAccessibilityLabels } from "@/shared/components/site-header-config";
import { createSiteHeaderLinks } from "@/shared/components/site-header-links";

export function PrototypeSiteHeader({ locale }: { readonly locale: Locale }) {
  return (
    <SiteHeader
      {...getSiteHeaderAccessibilityLabels(locale)}
      account={{
        label: m.accountNavLabel({}, { locale }),
        href: Promise.resolve(getAccountPath(locale)),
        signInHref: getAccountSignInPath(locale),
      }}
      contactHref={getCoworkReservationPath(locale)}
      contactLabel={m.reservationNavCta({}, { locale })}
      currentLocale={locale}
      links={createSiteHeaderLinks(locale)}
    />
  );
}
