import { Effect } from "effect";
import { publicOfferingsMarkdown } from "@/features/checkout/public-offerings-markdown";
import { getWorkspacePageUrl, type Locale, m } from "@/features/i18n";
import type { PublicPageMarkdownSources } from "@/features/public-pages/public-page-markdown";
import { tableReservationPath } from "@/features/reservation/routes";
import {
  type MarkdownBlocks,
  markdownHeading,
  markdownLink,
  markdownList,
  markdownListItem,
  markdownParagraph,
} from "@/shared/markdown/markdown";
import { workspaceSiteConstants } from "@/shared/utils/site-constants";
import { getPriceFamilies } from "./price-family";
import { teamTablePriceMarkdown } from "./team-table-price-markdown";

/**
 * The price page as Markdown: the opening hours, every offering at its
 * advertised price under its reservation family, and the address.
 */
export const pricingPageMarkdown = (
  locale: Locale,
  { offerings, teamTablePrices }: PublicPageMarkdownSources
): Effect.Effect<MarkdownBlocks> => {
  const { address } = workspaceSiteConstants.location;
  const { openSpaceUsableUntil } = workspaceSiteConstants.openingHours;

  return Effect.map(
    Effect.all(
      { loaded: offerings, tablePrices: teamTablePrices },
      { concurrency: "unbounded" }
    ),
    ({ loaded, tablePrices }) => [
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
        ({ title, offerings: rows }) => [
          markdownHeading(2, title),
          publicOfferingsMarkdown(rows, locale),
        ]
      ),
      ...(tablePrices.length > 0
        ? [
            markdownHeading(2, m.reservationTableProductTitle({}, { locale })),
            teamTablePriceMarkdown(tablePrices, locale),
            markdownParagraph(
              markdownLink(
                getWorkspacePageUrl(tableReservationPath),
                m.landingOfferingTeamTableBookingLink({}, { locale })
              )
            ),
          ]
        : []),
      markdownHeading(2, m.contactAddressLabel({}, { locale })),
      markdownParagraph(
        `${address.street}, ${address.cityDistrict}, ${address.postalCode} ${address.city}`
      ),
    ]
  );
};
