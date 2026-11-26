import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  getWorkspaceMeetingRoomProductTitle,
  getWorkspaceOfficeProductTitle,
} from "@/features/checkout/product-catalog.i18n";
import type { PublicOffering } from "@/features/checkout/public-offerings";
import { advertisedCatalogOfferings } from "@/features/checkout/public-offerings.test-utils";
import { type Locale, locales, m } from "@/features/i18n";
import { getPassTierName } from "@/features/passes/pass-offer.i18n";
import type { PublicPageMarkdownSources } from "@/features/public-pages/public-page-markdown";
import { serializeMarkdown } from "@/shared/markdown/markdown";
import { markdownPlainText } from "@/shared/markdown/markdown.test-utils";
import { currencyCZK } from "@/shared/money/currencies";
import { formatMoney } from "@/shared/money/money";
import { workspaceSiteConstants } from "@/shared/utils/site-constants";
import { pricingPageMarkdown } from "./pricing-page-markdown";

const renderPricingPage = async (
  locale: Locale,
  offerings: ReadonlyArray<PublicOffering>,
  pricingPasses?: PublicPageMarkdownSources["pricingPasses"]
) =>
  serializeMarkdown(
    await Effect.runPromise(
      pricingPageMarkdown(locale, {
        isPublished: () => true,
        offerings: Effect.succeed(offerings),
        saleBanner: Effect.succeed(undefined),
        pricingPasses,
      })
    )
  );

const headings = (markdown: string, depth: number) =>
  markdown
    .split("\n")
    .filter((line) => line.startsWith(`${"#".repeat(depth)} `))
    .map((line) => line.slice(depth + 1));

describe.each(locales)("pricingPageMarkdown in %s", (locale) => {
  test("lists the opening hours, every price by family, and the address", async () => {
    const markdown = await renderPricingPage(
      locale,
      advertisedCatalogOfferings({ locale, office: {} })
    );
    const text = markdownPlainText(markdown);
    const { address } = workspaceSiteConstants.location;

    expect(markdown).toStartWith(`# ${m.pricingPageTitle({}, { locale })}`);
    expect(headings(markdown, 2)).toEqual([
      m.pricingOpeningHoursTitle({}, { locale }),
      m.pricingCoworkTitle({}, { locale }),
      getWorkspaceMeetingRoomProductTitle(locale),
      getWorkspaceOfficeProductTitle(locale),
      m.contactAddressLabel({}, { locale }),
    ]);
    for (const line of [
      m.pricingOpeningHoursSpace({}, { locale }),
      m.pricingOpeningHoursOpenSpace({ until: "17:00" }, { locale }),
      m.pricingOpeningHoursCodeAccess({}, { locale }),
      `${address.street}, ${address.cityDistrict}, ${address.postalCode} ${address.city}`,
      ...[29_000, 41_000, 35_000, 98_000, 182_000, 53_000, 31_500].map(
        (value) =>
          // Plain text collapses the formatter's no-break spaces.
          formatMoney(currencyCZK(value), locale).replace(/\s+/g, " ")
      ),
    ]) {
      expect(text).toContain(line);
    }
  });

  test("leaves out the office while its page is unpublished", async () => {
    const markdown = await renderPricingPage(
      locale,
      advertisedCatalogOfferings({ locale })
    );

    expect(headings(markdown, 2)).not.toContain(
      getWorkspaceOfficeProductTitle(locale)
    );
  });

  test("lists released entry packs and memberships with their prices", async () => {
    const markdown = await renderPricingPage(
      locale,
      advertisedCatalogOfferings({ locale }),
      { offersAutoRenewal: false }
    );
    const text = markdownPlainText(markdown);

    expect(headings(markdown, 2)).toContain(
      m.entryPackDiscoveryTitle({}, { locale })
    );
    expect(headings(markdown, 2)).toContain(m.passUnlimited({}, { locale }));
    expect(headings(markdown, 3)).toContain(
      getPassTierName("reserved-desk-workstation", locale)
    );
    expect(markdown).toContain(
      "https://workspace.deskohub.cz/passes/entry-pack?tier=open-space"
    );
    expect(markdown).toContain(
      "https://workspace.deskohub.cz/passes/unlimited?tier=reserved-desk-workstation"
    );
    for (const cents of [
      115_000, 219_000, 159_000, 309_000, 205_000, 399_000, 349_000, 599_000,
      849_000, 69_000,
    ]) {
      expect(text).toContain(
        formatMoney(currencyCZK(cents), locale).replace(/\s+/g, " ")
      );
    }
    expect(text).toContain(m.reservationReservedDeskPerkCoffee({}, { locale }));
    expect(text).not.toContain(
      m.unlimitedPassDiscoveryAutoRenewal({ days: 30 }, { locale })
    );
  });
});

test("discloses optional 30-day renewal for a membership bought for yourself", async () => {
  const locale = "en-US";
  const markdown = await renderPricingPage(
    locale,
    advertisedCatalogOfferings({ locale }),
    { offersAutoRenewal: true }
  );

  expect(markdown).toContain(
    "If you're buying a membership for yourself, you can choose automatic renewal every 30 days."
  );
});
