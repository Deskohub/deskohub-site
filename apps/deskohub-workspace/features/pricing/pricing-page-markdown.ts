import { Effect } from "effect";
import { publicOfferingsMarkdown } from "@/features/checkout/public-offerings-markdown";
import { getWorkspacePageUrl, type Locale, m } from "@/features/i18n";
import {
  getEntryPackPricePerDay,
  getEntryPackPurchasePath,
} from "@/features/passes/entry-pack-discovery";
import {
  entryPackOffers,
  passTiers,
  unlimitedPassDays,
  unlimitedPassOffers,
} from "@/features/passes/pass-offer";
import { getPassTierName } from "@/features/passes/pass-offer.i18n";
import { getUnlimitedPassPurchasePath } from "@/features/passes/unlimited-pass-discovery";
import type { PublicPageMarkdownSources } from "@/features/public-pages/public-page-markdown";
import {
  type MarkdownBlocks,
  markdownHeading,
  markdownLink,
  markdownList,
  markdownListItem,
  markdownParagraph,
} from "@/shared/markdown/markdown";
import { formatMoney } from "@/shared/money/money";
import { workspaceSiteConstants } from "@/shared/utils/site-constants";
import { getPriceFamilies } from "./price-family";
import { getUnlimitedPassPriceCopy } from "./unlimited-pass-price-copy";

/**
 * The price page as Markdown: the opening hours, every offering at its
 * advertised price under its reservation family, and the address.
 */
export const pricingPageMarkdown = (
  locale: Locale,
  { offerings, pricingPasses }: PublicPageMarkdownSources
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
        ...(kind === "cowork" && pricingPasses
          ? passPricesMarkdown(locale, pricingPasses.offersAutoRenewal)
          : []),
      ]
    ),
    markdownHeading(2, m.contactAddressLabel({}, { locale })),
    markdownParagraph(
      `${address.street}, ${address.cityDistrict}, ${address.postalCode} ${address.city}`
    ),
  ]);
};

const passPricesMarkdown = (
  locale: Locale,
  offersAutoRenewal: boolean
): MarkdownBlocks => [
  markdownHeading(2, m.entryPackDiscoveryTitle({}, { locale })),
  markdownParagraph(m.entryPackDiscoveryIntro({}, { locale })),
  ...passTiers.flatMap((tier) => {
    const name = getPassTierName(tier, locale);
    const description = {
      "open-space": m.entryPackDiscoveryOpenSpaceDescription,
      "reserved-desk": m.entryPackDiscoveryReservedDeskDescription,
      "reserved-desk-workstation": m.entryPackDiscoveryWorkstationDescription,
    }[tier]({}, { locale });
    return [
      markdownHeading(3, name),
      markdownParagraph(description),
      markdownList(
        entryPackOffers
          .filter(({ product }) => product.tier === tier)
          .map((offer) =>
            markdownListItem(
              `${formatMoney(offer.price, locale)}. ${m.entryPackDiscoveryValidity(
                { entries: offer.product.size, months: offer.validityMonths },
                { locale }
              )}. ${m.entryPackDiscoveryPerDay(
                { price: formatMoney(getEntryPackPricePerDay(offer), locale) },
                { locale }
              )}.`
            )
          )
      ),
      markdownParagraph(
        markdownLink(
          getWorkspacePageUrl(getEntryPackPurchasePath(locale, tier)),
          m.entryPackDiscoveryBuyTier({ tier: name }, { locale })
        )
      ),
    ];
  }),
  markdownHeading(2, m.passUnlimited({}, { locale })),
  markdownParagraph(m.unlimitedPassDiscoveryIntro({}, { locale })),
  ...(offersAutoRenewal
    ? [
        markdownParagraph(
          m.unlimitedPassDiscoveryAutoRenewal(
            { days: unlimitedPassDays },
            { locale }
          )
        ),
      ]
    : []),
  ...unlimitedPassOffers.flatMap(
    ({ product: { tier }, price, validityDays }) => {
      const name = getPassTierName(tier, locale);
      const copy = getUnlimitedPassPriceCopy(tier, price, validityDays, locale);
      return [
        markdownHeading(3, name),
        markdownParagraph(copy.description),
        markdownList(
          [copy.period, copy.perDay, copy.coffee].map((line) =>
            markdownListItem(line)
          )
        ),
        markdownParagraph(
          markdownLink(
            getWorkspacePageUrl(getUnlimitedPassPurchasePath(locale, { tier })),
            m.unlimitedPassDiscoveryBuyTier({ tier: name }, { locale })
          )
        ),
      ];
    }
  ),
];
