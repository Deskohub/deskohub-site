import "server-only";

import type { passPurchases } from "@/db/schema";
import type { Locale } from "@/features/i18n";
import { getLegalDocumentVersion } from "@/features/legal/document-version";
import { getLegalDocumentPath } from "@/features/legal/legal-document-path";
import { supportsUnlimitedAutoRenewalTerms } from "@/features/legal/unlimited-auto-renewal-terms";
import { moneyEquals } from "@/shared/money/money";
import { getUnlimitedPassPrice } from "../pass-offer";
import { withPassPurchaseAddons } from "../pass-purchase-quote";
import type {
  UnlimitedAutoRenewalAuthorization,
  UnlimitedAutoRenewalDisclosure,
} from "../unlimited-auto-renewal";
import { isUnlimitedAutoRenewalPreviewEnabled } from "./unlimited-auto-renewal-preview.server";

type RenewalPurchase = Pick<
  typeof passPurchases.$inferSelect,
  "autoRenew" | "locale" | "tier" | "unlimitedCoffee" | "validUntil"
>;

export const offersUnlimitedAutoRenewal = (locale: Locale) =>
  isUnlimitedAutoRenewalPreviewEnabled() &&
  supportsUnlimitedAutoRenewalTerms(locale);

export function readUnlimitedAutoRenewalDisclosure(
  purchase: RenewalPurchase
): UnlimitedAutoRenewalDisclosure | undefined {
  if (!purchase.autoRenew || !offersUnlimitedAutoRenewal(purchase.locale)) {
    return undefined;
  }

  return {
    amount: withPassPurchaseAddons(
      getUnlimitedPassPrice({ kind: "unlimited", tier: purchase.tier }),
      purchase.unlimitedCoffee
    ),
    nextRenewalOn: purchase.validUntil,
    termsHash: getLegalDocumentVersion(purchase.locale, "terms-and-conditions"),
    termsPath: getLegalDocumentPath(purchase.locale, "terms-and-conditions"),
  };
}

export const matchesUnlimitedAutoRenewalAuthorization = (
  accepted: UnlimitedAutoRenewalAuthorization | undefined,
  disclosed: UnlimitedAutoRenewalDisclosure
) =>
  accepted !== undefined &&
  accepted.termsHash === disclosed.termsHash &&
  accepted.nextRenewalOn === disclosed.nextRenewalOn &&
  moneyEquals(accepted.amount, disclosed.amount);
