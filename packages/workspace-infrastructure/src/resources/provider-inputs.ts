/**
 * A prop of a provider diff's `news` that is already a plain string. While
 * a plan runs, the props or the prop can still be an unresolved Output,
 * Config or Effect, which cannot differ yet, so it reads as `undefined`.
 */
export const resolvedStringProp = (news: object, key: string) => {
  const value: unknown = Reflect.get(news, key);
  return typeof value === "string" ? value : undefined;
};
