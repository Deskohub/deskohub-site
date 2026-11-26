import { Predicate } from "effect";
import type { PhrasingContent } from "mdast";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { getWorkspacePageUrl } from "@/features/i18n";
import { markdownLink, markdownText } from "@/shared/markdown/markdown";
import { getWorkspaceCanonicalUrl } from "@/shared/utils/site-constants";

type LegalElementProps = {
  readonly children?: ReactNode;
  readonly href?: string;
  readonly hrefLang?: string;
};

// Keep the locale when the author explicitly links to a language variant.
const absoluteHref = (href: string, hrefLang: string | undefined) => {
  if (!href.startsWith("/")) return href;
  return hrefLang ? getWorkspaceCanonicalUrl(href) : getWorkspacePageUrl(href);
};

/** Nodes React renders as nothing. */
const isEmptyLegalNode = (node: ReactNode) =>
  node === null || node === undefined || Predicate.isBoolean(node);

/**
 * An element's phrasing: an anchor with a target links its children; any
 * other element contributes its children alone.
 */
const legalElementToPhrasing = (
  element: ReactElement<LegalElementProps>
): PhrasingContent[] => {
  const { href, hrefLang, children: authoredChildren } = element.props;
  const children = legalNodeToPhrasing(authoredChildren);
  return element.type === "a" && href
    ? [markdownLink(absoluteHref(href, hrefLang), ...children)]
    : children;
};

/**
 * The authored legal body as Markdown phrasing: text stays text and an
 * anchor becomes a link to its target. Any other element contributes its
 * children, as `getCanonicalLegalDocument` reads them.
 */
export const legalNodeToPhrasing = (node: ReactNode): PhrasingContent[] => {
  if (isEmptyLegalNode(node)) {
    return [];
  }
  if (Predicate.isString(node) || Predicate.isNumber(node)) {
    return [markdownText(String(node))];
  }
  if (Array.isArray(node)) {
    return Children.toArray(node).flatMap(legalNodeToPhrasing);
  }
  if (isValidElement<LegalElementProps>(node)) {
    return legalElementToPhrasing(node);
  }
  return [];
};
