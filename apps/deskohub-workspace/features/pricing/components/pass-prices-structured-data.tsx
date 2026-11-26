import { getWorkspacePageUrl, type Locale, m } from "@/features/i18n";
import { getEntryPackPurchasePath } from "@/features/passes/entry-pack-discovery";
import {
  entryPackOffers,
  unlimitedPassOffers,
} from "@/features/passes/pass-offer";
import { getPassTierName } from "@/features/passes/pass-offer.i18n";
import { getUnlimitedPassPurchasePath } from "@/features/passes/unlimited-pass-discovery";
import { StructuredData } from "@/shared/components/structured-data";
import { moneyMajorAmount } from "@/shared/money/money";
import {
  getStructuredDataDocument,
  workspaceBusinessId,
} from "@/shared/utils/structured-data";
import { getUnlimitedPassPriceCopy } from "../unlimited-pass-price-copy";

export function PassPricesStructuredData({
  locale,
}: {
  readonly locale: Locale;
}) {
  const entryPacks = entryPackOffers.map(
    ({ product: { tier, size }, price, validityMonths }) => ({
      "@type": "Offer",
      name: `${m.entryPackDiscoveryTitle({}, { locale })} (${getPassTierName(tier, locale)}, ${m.passEntryCount({ count: size }, { locale })})`,
      description: m.entryPackDiscoveryValidity(
        { entries: size, months: validityMonths },
        { locale }
      ),
      price: moneyMajorAmount(price),
      priceCurrency: price.currency,
      url: getWorkspacePageUrl(getEntryPackPurchasePath(locale, tier), {
        size: String(size),
      }),
      seller: { "@id": workspaceBusinessId },
    })
  );
  const memberships = unlimitedPassOffers.map(
    ({ product: { tier }, price, validityDays }) => {
      const copy = getUnlimitedPassPriceCopy(tier, price, validityDays, locale);
      return {
        "@type": "Offer",
        name: `${m.passUnlimited({}, { locale })} (${getPassTierName(tier, locale)})`,
        description: `${m.unlimitedPassDiscoveryIntro({}, { locale })} ${copy.description} ${copy.coffee}`,
        price: moneyMajorAmount(price),
        priceCurrency: price.currency,
        url: getWorkspacePageUrl(
          getUnlimitedPassPurchasePath(locale, { tier })
        ),
        seller: { "@id": workspaceBusinessId },
      };
    }
  );

  return (
    <StructuredData
      data={getStructuredDataDocument({
        "@graph": [...entryPacks, ...memberships],
      })}
    />
  );
}
