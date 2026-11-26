import "server-only";

import type { Locale } from "@/features/i18n";
import { isUnlimitedAutoRenewalPreviewEnabled } from "@/features/passes/backend/unlimited-auto-renewal-preview.server";
import { getLegalDocument, type LegalDocumentContent } from "./content";
import type { LegalDocumentKey } from "./legal-document-summaries";
import { unlimitedAutoRenewalSection as czech } from "./locales/cs-CZ/unlimited-auto-renewal-section";
import { unlimitedAutoRenewalSection as english } from "./locales/en-US/unlimited-auto-renewal-section";
import { supportsUnlimitedAutoRenewalTerms } from "./unlimited-auto-renewal-terms";

const unlimitedAutoRenewalSections = { "cs-CZ": czech, "en-US": english };

export function getPreviewLegalDocument(
  locale: Locale,
  documentKey: LegalDocumentKey
): LegalDocumentContent | undefined {
  if (
    documentKey !== "terms-and-conditions" ||
    !supportsUnlimitedAutoRenewalTerms(locale) ||
    !isUnlimitedAutoRenewalPreviewEnabled()
  ) {
    return undefined;
  }

  const terms = getLegalDocument(locale, documentKey);
  return {
    ...terms,
    sections: [...terms.sections, unlimitedAutoRenewalSections[locale]],
  };
}

export function getServedLegalDocument(
  locale: Locale,
  documentKey: LegalDocumentKey
): LegalDocumentContent {
  return (
    getPreviewLegalDocument(locale, documentKey) ??
    getLegalDocument(locale, documentKey)
  );
}
