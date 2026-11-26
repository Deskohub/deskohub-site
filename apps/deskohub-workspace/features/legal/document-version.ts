import type { Locale } from "@/features/i18n";
import { hashLegalDocument } from "./canonical-document";
import { getLegalDocument } from "./content";
import { getPreviewLegalDocument } from "./content.server";
import { getLegalDocumentPath } from "./legal-document-path";
import type { LegalDocumentKey } from "./legal-document-summaries";

export {
  hashLegalDocument,
  legalDocumentHashAlgorithm,
} from "./canonical-document";

const documentVersions = new Map<string, string>();

/** The version of the served document. Published versions are cached by path. */
export function getLegalDocumentVersion(
  locale: Locale,
  documentKey: LegalDocumentKey
): string {
  const preview = getPreviewLegalDocument(locale, documentKey);
  if (preview !== undefined) {
    return hashLegalDocument(preview);
  }

  const path = getLegalDocumentPath(locale, documentKey);
  const cached = documentVersions.get(path);
  if (cached !== undefined) {
    return cached;
  }

  const version = hashLegalDocument(getLegalDocument(locale, documentKey));
  documentVersions.set(path, version);
  return version;
}
