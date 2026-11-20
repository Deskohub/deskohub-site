import type { Locale } from "@/features/i18n";
import type { PassTier } from "./pass-offer";

export function getUnlimitedPassPurchasePath(
  locale: Locale,
  tier: PassTier,
  startDate?: string
) {
  const query = new URLSearchParams({ tier });
  if (startDate) query.set("startDate", startDate);
  return `/${locale}/passes/unlimited?${query}`;
}
