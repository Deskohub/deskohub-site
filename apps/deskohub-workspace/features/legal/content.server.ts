import "server-only";

import type { Locale } from "@/features/i18n";
import { isUnlimitedAutoRenewalPreviewEnabled } from "@/features/passes/backend/unlimited-auto-renewal-preview.server";
import { getLegalDocument, type LegalDocumentContent } from "./content";
import type { LegalDocumentKey } from "./legal-document-summaries";
import { unlimitedAutoRenewalLegalDocuments as czech } from "./locales/cs-CZ/documents";
import { unlimitedAutoRenewalLegalDocuments as english } from "./locales/en-US/documents";
import { supportsUnlimitedAutoRenewalTerms } from "./unlimited-auto-renewal-terms";

const unlimitedAutoRenewalDocuments = { "cs-CZ": czech, "en-US": english };

export function getPreviewLegalDocument(
  locale: Locale,
  documentKey: LegalDocumentKey
): LegalDocumentContent | undefined {
  if (
    !supportsUnlimitedAutoRenewalTerms(locale) ||
    !isUnlimitedAutoRenewalPreviewEnabled() ||
    documentKey === "cookie-policy" ||
    documentKey === "marketing-communications"
  ) {
    return undefined;
  }

  return {
    ...getLegalDocument(locale, documentKey),
    ...unlimitedAutoRenewalDocuments[locale][documentKey],
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
