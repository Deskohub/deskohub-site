import type { Locale } from "@/features/i18n";

/** Locales in which checkout can show the complete renewal terms. */
export function supportsUnlimitedAutoRenewalTerms(
  locale: Locale
): locale is "cs-CZ" | "en-US" {
  return locale === "cs-CZ" || locale === "en-US";
}
