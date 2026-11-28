import { createHash } from "node:crypto";
import { Predicate } from "effect";
import { Children, isValidElement, type ReactNode } from "react";
import type { LegalDocumentContent } from "./content";

export const legalDocumentHashAlgorithm = "sha256";

function reactNodeToCanonicalText(node: ReactNode): string {
  if (node === null || node === undefined || Predicate.isBoolean(node)) {
    return "";
  }

  if (Predicate.isString(node) || Predicate.isNumber(node)) {
    return String(node);
  }

  if (Array.isArray(node)) {
    return Children.toArray(node).map(reactNodeToCanonicalText).join("");
  }

  if (isValidElement<{ children?: ReactNode }>(node)) {
    return reactNodeToCanonicalText(node.props.children);
  }

  return "";
}

export function getCanonicalLegalDocument(
  document: LegalDocumentContent
): string {
  return JSON.stringify({
    title: document.title,
    lead: document.lead,
    updatedAt: document.updatedAt,
    translationNotice: document.translationNotice,
    sections: document.sections.map((section) => ({
      heading: section.heading,
      body: section.body.map(reactNodeToCanonicalText),
    })),
  });
}

/** Hashes the text and metadata that identify the accepted legal document. */
export function hashLegalDocument(document: LegalDocumentContent): string {
  return createHash(legalDocumentHashAlgorithm)
    .update(getCanonicalLegalDocument(document))
    .digest("hex");
}
