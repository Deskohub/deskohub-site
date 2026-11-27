import { afterEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { locales, m } from "@/features/i18n";
import { serializeMarkdown } from "@/shared/markdown/markdown";
import {
  markdownLinkUrls,
  markdownPlainText,
} from "@/shared/markdown/markdown.test-utils";
import { getCanonicalLegalDocument } from "./canonical-document";
import { InAppLegalPage } from "./components/in-app-legal-page";
import { LegalPage } from "./components/legal-page";
import { getLegalDocument } from "./content";
import { getServedLegalDocument } from "./content.server";
import { getLegalDocumentVersion, hashLegalDocument } from "./document-version";
import { legalPageMarkdown } from "./legal-page-markdown";
import {
  getPaymentSubmitLegalDocuments,
  getPaymentSubmitLegalEvidence,
  isCurrentPaymentSubmitLegalAcceptance,
} from "./payment-submit-evidence";
import { supportsUnlimitedAutoRenewalTerms } from "./unlimited-auto-renewal-terms";

const documentKey = "terms-and-conditions";
const membershipDocumentKeys = [
  documentKey,
  "privacy-policy",
  "operating-rules",
] as const;
let previewEnabled = false;

type CanonicalSections = {
  readonly sections: ReadonlyArray<{
    readonly heading: string;
    readonly body: ReadonlyArray<string>;
  }>;
};

mock.module(
  "@/features/passes/backend/unlimited-auto-renewal-preview.server",
  () => ({ isUnlimitedAutoRenewalPreviewEnabled: () => previewEnabled })
);

afterEach(() => {
  previewEnabled = false;
});

const collapseWhitespace = (value: string) => value.replace(/\s+/g, " ").trim();

describe.each([
  [
    "cs-CZ",
    "16. Automatické obnovování neomezeného členství",
    "1. prosince 2026",
  ],
  [
    "en-US",
    "16. Automatic renewal of Unlimited memberships",
    "1 December 2026",
  ],
] as const)("Unlimited renewal terms in %s", (locale, heading, updatedAt) => {
  test.each(membershipDocumentKeys)(
    "serves the same %s in site HTML, in-app HTML, Markdown and version evidence",
    (key) => {
      const published = getLegalDocument(locale, key);
      const publishedHash = getLegalDocumentVersion(locale, key);
      previewEnabled = true;
      const served = getServedLegalDocument(locale, key);
      const canonical: CanonicalSections = JSON.parse(
        getCanonicalLegalDocument(served)
      );
      expect(published.updatedAt).toBe(updatedAt);
      expect(served.updatedAt).toBe(updatedAt);
      expect(served.translationNotice).toBe(published.translationNotice);
      const site = renderToStaticMarkup(
        <LegalPage locale={locale} documentKey={key} />
      );
      const inApp = renderToStaticMarkup(
        <InAppLegalPage locale={locale} documentKey={key} />
      );
      const markdown = serializeMarkdown(legalPageMarkdown(locale, key));
      for (const html of [site, inApp]) {
        expect(html).toContain(served.updatedAt);
        // The app can add its query parameter to links to other legal pages.
        const content = html.replaceAll(/ href="[^"]+"/g, "");
        for (const section of served.sections) {
          expect(html).toContain(renderToStaticMarkup(section.heading));
          for (const paragraph of section.body) {
            expect(content).toContain(
              renderToStaticMarkup(paragraph).replaceAll(/ href="[^"]+"/g, "")
            );
          }
        }
      }
      expect(markdownPlainText(markdown)).toBe(
        [
          served.title,
          served.lead,
          `${m.legalPageLastUpdatedLabel({}, { locale })}: ${served.updatedAt}`,
          served.translationNotice ?? "",
          ...canonical.sections.flatMap(({ heading, body }) => [
            heading,
            ...body,
          ]),
        ]
          .map(collapseWhitespace)
          .filter(Boolean)
          .join("\n")
      );
      expect(getLegalDocumentVersion(locale, key)).toBe(
        hashLegalDocument(served)
      );
      expect(getLegalDocumentVersion(locale, key)).not.toBe(publishedHash);

      previewEnabled = false;
      expect(getServedLegalDocument(locale, key)).toEqual(published);
      expect(getLegalDocumentVersion(locale, key)).toBe(publishedHash);
    }
  );

  test("links to the numbered renewal section and localized pricing", () => {
    const published = markdownPlainText(
      serializeMarkdown(legalPageMarkdown(locale, documentKey))
    );
    expect(published).not.toContain(heading);
    previewEnabled = true;
    const site = renderToStaticMarkup(
      <LegalPage locale={locale} documentKey={documentKey} />
    );
    const inApp = renderToStaticMarkup(
      <InAppLegalPage locale={locale} documentKey={documentKey} />
    );
    expect(site).toContain("scroll-mt-[calc(var(--site-header-height)+1rem)]");
    for (const html of [site, inApp]) {
      expect(html).toContain('id="section-16"');
      expect(html).toContain(heading);
      expect(html).toContain(`href="/${locale}/pricing"`);
    }
    const markdown = serializeMarkdown(legalPageMarkdown(locale, documentKey));
    expect(markdownLinkUrls(markdown)).toContain(
      `https://workspace.deskohub.cz/${locale}/pricing`
    );
    expect(markdownPlainText(markdown).match(/^16\.\d+(?= )/gm)).toEqual(
      Array.from({ length: 9 }, (_, index) => `16.${index + 1}`)
    );
    const plainText = markdownPlainText(markdown);
    expect(plainText).not.toContain("16.11");
    for (const clause of ["7.5 ", "7.6 ", "9.3 ", "9.8 "]) {
      const publishedClause = published
        .split("\n")
        .find((line) => line.startsWith(clause));
      expect(publishedClause).toBeString();
      expect(
        plainText.split("\n").find((line) => line.startsWith(clause))
      ).toBe(publishedClause);
    }
    expect(
      plainText.split("\n").find((line) => line.startsWith("9.7 "))
    ).toContain(
      locale === "en-US"
        ? "A valid statutory withdrawal also stops automatic renewal."
        : "Platným odstoupením podle zákona se také ukončí automatické obnovování."
    );
    const getOrderClause = (document: ReturnType<typeof getLegalDocument>) => {
      const canonical: CanonicalSections = JSON.parse(
        getCanonicalLegalDocument(document)
      );
      return canonical.sections
        .find(({ heading }) => heading.startsWith("4. "))
        ?.body.find((paragraph) => paragraph.startsWith("4.2 "));
    };
    expect(getOrderClause(getLegalDocument(locale, documentKey))).toBeString();
    expect(getOrderClause(getServedLegalDocument(locale, documentKey))).toBe(
      getOrderClause(getLegalDocument(locale, documentKey))
    );
  });

  test("keeps recurring payment references in privacy section 6 gated", () => {
    const getRecipients = () => {
      const canonical: CanonicalSections = JSON.parse(
        getCanonicalLegalDocument(
          getServedLegalDocument(locale, "privacy-policy")
        )
      );
      return canonical.sections
        .find(({ heading }) => heading.startsWith("6. "))
        ?.body.join(" ");
    };
    const publishedRecipients = getRecipients();
    expect(publishedRecipients).toBeString();
    expect(publishedRecipients).not.toContain("Nexi");
    previewEnabled = true;
    expect(getRecipients()).toContain("Nexi");
  });

  test("records the served terms and house rules and rejects older acceptance", () => {
    const publishedAcceptance = getPaymentSubmitLegalDocuments(locale);
    const publishedHash = getLegalDocumentVersion(locale, documentKey);
    expect(publishedHash).toBe(
      hashLegalDocument(getLegalDocument(locale, documentKey))
    );

    previewEnabled = true;
    const draftHash = getLegalDocumentVersion(locale, documentKey);
    expect(draftHash).not.toBe(publishedHash);
    expect(draftHash).toBe(
      hashLegalDocument(getServedLegalDocument(locale, documentKey))
    );
    const draftAcceptance = getPaymentSubmitLegalDocuments(locale);
    expect(draftAcceptance).toContainEqual({
      key: documentKey,
      path: `/${locale}/${documentKey}`,
      hash: draftHash,
      hashAlgorithm: "sha256",
    });
    expect(draftAcceptance).toContainEqual({
      key: "operating-rules",
      path: `/${locale}/operating-rules`,
      hash: hashLegalDocument(
        getServedLegalDocument(locale, "operating-rules")
      ),
      hashAlgorithm: "sha256",
    });
    expect(isCurrentPaymentSubmitLegalAcceptance(locale, draftAcceptance)).toBe(
      true
    );
    expect(
      isCurrentPaymentSubmitLegalAcceptance(locale, publishedAcceptance)
    ).toBe(false);
    const evidence = getPaymentSubmitLegalEvidence({
      locale,
      acceptedAt: "2026-11-26T12:00:00Z",
      earlyPerformanceConsent: false,
    });
    expect(evidence[draftHash]?.documentHash).toBe(draftHash);
    expect(evidence[publishedHash]).toBeUndefined();

    previewEnabled = false;
    expect(getLegalDocumentVersion(locale, documentKey)).toBe(publishedHash);
    expect(getPaymentSubmitLegalDocuments(locale)).toEqual(publishedAcceptance);
  });
});

test("keeps other locales and documents on their published version in preview", () => {
  previewEnabled = true;
  expect(locales.filter(supportsUnlimitedAutoRenewalTerms).toSorted()).toEqual([
    "cs-CZ",
    "en-US",
  ]);

  for (const locale of locales) {
    for (const key of [
      ...membershipDocumentKeys,
      "marketing-communications",
      "cookie-policy",
    ] as const) {
      if (
        supportsUnlimitedAutoRenewalTerms(locale) &&
        membershipDocumentKeys.some((document) => document === key)
      )
        continue;
      expect(getServedLegalDocument(locale, key)).toEqual(
        getLegalDocument(locale, key)
      );
    }
  }
});
