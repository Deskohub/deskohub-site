import { afterEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { locales } from "@/features/i18n";
import { serializeMarkdown } from "@/shared/markdown/markdown";
import { markdownPlainText } from "@/shared/markdown/markdown.test-utils";
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

describe.each([
  ["cs-CZ", "16. Automatické obnovování členství Unlimited"],
  ["en-US", "16. Automatic renewal of Unlimited memberships"],
] as const)("Unlimited renewal terms in %s", (locale, heading) => {
  test("serves the same draft in site HTML, in-app HTML and Markdown", () => {
    previewEnabled = true;
    const published = getLegalDocument(locale, documentKey);
    const served = getServedLegalDocument(locale, documentKey);
    const draft = served.sections.at(-1);

    expect(draft?.heading).toBe(heading);
    expect(served.updatedAt).toBe(published.updatedAt);
    expect(served.sections.slice(0, -1)).toEqual(published.sections);
    const site = renderToStaticMarkup(
      <LegalPage locale={locale} documentKey={documentKey} />
    );
    const inApp = renderToStaticMarkup(
      <InAppLegalPage locale={locale} documentKey={documentKey} />
    );
    const markdown = markdownPlainText(
      serializeMarkdown(legalPageMarkdown(locale, documentKey))
    );
    const canonical: CanonicalSections = JSON.parse(
      getCanonicalLegalDocument(served)
    );
    const canonicalDraft = canonical.sections.at(-1);

    for (const html of [site, inApp]) {
      expect(html).toContain(heading);
      for (const paragraph of draft?.body ?? []) {
        expect(html).toContain(renderToStaticMarkup(paragraph));
      }
    }
    expect(markdown.split("\n").slice(-10)).toEqual([
      heading,
      ...(canonicalDraft?.body ?? []).map((line) =>
        line.replace(/\s+/g, " ").trim()
      ),
    ]);
    expect(markdown.match(/^16\.\d+(?= )/gm)).toEqual(
      Array.from({ length: 9 }, (_, index) => `16.${index + 1}`)
    );

    previewEnabled = false;
    expect(getServedLegalDocument(locale, documentKey)).toEqual(published);
    expect(
      serializeMarkdown(legalPageMarkdown(locale, documentKey))
    ).not.toContain(heading);
  });

  test("records the exact served terms hash and rejects baseline acceptance in preview", () => {
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
    if (!supportsUnlimitedAutoRenewalTerms(locale)) {
      expect(getServedLegalDocument(locale, documentKey)).toEqual(
        getLegalDocument(locale, documentKey)
      );
    }
    expect(getServedLegalDocument(locale, "operating-rules")).toEqual(
      getLegalDocument(locale, "operating-rules")
    );
  }
});
