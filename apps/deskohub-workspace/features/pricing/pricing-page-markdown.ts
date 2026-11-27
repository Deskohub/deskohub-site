import { Effect } from "effect";
import { publicOfferingsMarkdown } from "@/features/checkout/public-offerings-markdown";
import { type Locale, m } from "@/features/i18n";
import { unlimitedPassOffers } from "@/features/passes/pass-offer";
import { getPassTierName } from "@/features/passes/pass-offer.i18n";
import type { PublicPageMarkdownSources } from "@/features/public-pages/public-page-markdown";
import {
  type MarkdownBlocks,
  markdownHeading,
  markdownList,
  markdownListItem,
  markdownParagraph,
} from "@/shared/markdown/markdown";
import { formatMoney } from "@/shared/money/money";
import { workspaceSiteConstants } from "@/shared/utils/site-constants";
import { getPriceFamilies } from "./price-family";

/**
 * The price page as Markdown: the opening hours, every offering at its
 * advertised price under its reservation family, and the address.
 */
export const pricingPageMarkdown = (
  locale: Locale,
  { coworkPassesPublished, offerings }: PublicPageMarkdownSources
): Effect.Effect<MarkdownBlocks> => {
  const { address } = workspaceSiteConstants.location;
  const { openSpaceUsableUntil } = workspaceSiteConstants.openingHours;

  return Effect.map(offerings, (loaded) => [
    markdownHeading(1, m.pricingPageTitle({}, { locale })),
    markdownParagraph(m.pricingIntro({}, { locale })),
    markdownHeading(2, m.pricingOpeningHoursTitle({}, { locale })),
    markdownList([
      markdownListItem(m.pricingOpeningHoursSpace({}, { locale })),
      markdownListItem(
        m.pricingOpeningHoursOpenSpace(
          { until: openSpaceUsableUntil },
          { locale }
        )
      ),
      markdownListItem(m.pricingOpeningHoursCodeAccess({}, { locale })),
    ]),
    ...getPriceFamilies(loaded, locale).flatMap(
      ({ kind, title, offerings: rows }) => [
        markdownHeading(2, title),
        publicOfferingsMarkdown(rows, locale),
        ...(kind === "cowork" && coworkPassesPublished
          ? [
              markdownHeading(2, m.passUnlimited({}, { locale })),
              markdownParagraph(m.unlimitedPassDiscoveryIntro({}, { locale })),
              markdownList(
                unlimitedPassOffers.map(({ product, price, validityDays }) =>
                  markdownListItem(
                    getPassTierName(product.tier, locale),
                    " · ",
                    m.unlimitedPassDiscoveryPrice(
                      { price: formatMoney(price, locale), days: validityDays },
                      { locale }
                    )
                  )
                )
              ),
            ]
          : []),
      ]
    ),
    markdownHeading(2, m.contactAddressLabel({}, { locale })),
    markdownParagraph(
      `${address.street}, ${address.cityDistrict}, ${address.postalCode} ${address.city}`
    ),
  ]);
};
