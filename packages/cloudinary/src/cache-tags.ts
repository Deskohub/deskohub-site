import { Predicate } from "effect";
import type { UnnormalizedLogicalExpression } from "./expression";
import type { CloudinaryPublicId } from "./schema";

const maxTagLength = 100;
const maxGroupItems = 50;
const maxDepth = 10;
const maxSerializedLength = 1000;

/** The tag cut to 100 characters. */
const truncateTag = (tag: string) =>
  tag.length > maxTagLength ? `${tag.substring(0, maxTagLength)}...` : tag;

const serializeExpression = (
  expression: UnnormalizedLogicalExpression<string>,
  depth = 0
): string => {
  if (depth > maxDepth) {
    return "[...]";
  }

  if (Predicate.isString(expression)) {
    return truncateTag(expression);
  }

  const items = expression
    .slice(0, maxGroupItems)
    .map((item) => serializeExpression(item, depth + 1));
  return `[${items.join(",")}${expression.length > maxGroupItems ? ",..." : ""}]`;
};

/** A short hash that is equal for equal tag expressions. */
export function createStableHash(
  expression: UnnormalizedLogicalExpression<string>
): string {
  const serialized = serializeExpression(expression).substring(
    0,
    maxSerializedLength
  );

  let hash = 0;
  for (let index = 0; index < serialized.length; index++) {
    hash = ((hash << 5) - hash + serialized.charCodeAt(index)) | 0;
  }

  return Math.abs(hash).toString(36);
}

export function createCloudinaryCacheTags({
  namespace,
}: {
  namespace: string;
}) {
  return {
    all: () => `${namespace}:all`,
    image: (publicId: CloudinaryPublicId) => `${namespace}:img:${publicId}`,
    search: (
      tags?: UnnormalizedLogicalExpression<string>,
      maxResults?: number
    ) => {
      const parts = [`${namespace}:search`];

      if (tags) {
        parts.push(`tags:${createStableHash(tags)}`);
      }

      if (maxResults) {
        parts.push(`limit:${maxResults}`);
      }

      return parts.join(":");
    },
    getTags: (publicId?: CloudinaryPublicId) => {
      const tags = [`${namespace}:all`];

      if (publicId) {
        tags.push(`${namespace}:img:${publicId}`);
      }

      return tags;
    },
  };
}
