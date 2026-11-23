import { Effect, Schema } from "effect";

/**
 * Response fields a newer `dhw` must still decode from an older server, which
 * omits fields it doesn't know yet. Each helper names the value an absent key
 * decodes to.
 */
export const fieldWithDefault = <S extends Schema.Top>(
  schema: S,
  value: S["Type"]
) => schema.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(value)));

/** A nullable response field; absent decodes as null. */
export const nullableField = <S extends Schema.Top>(schema: S) =>
  Schema.NullOr(schema).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(null))
  );

/** A list response field; absent decodes as empty. */
export const listField = <S extends Schema.Top>(schema: S) =>
  Schema.Array(schema).pipe(
    Schema.withDecodingDefaultTypeKey(
      Effect.succeed([] as ReadonlyArray<S["Type"]>)
    )
  );

/**
 * A count per key of a vocabulary. Each of `addedKeys` is a key an older
 * server doesn't send yet, so its count decodes as 0 when absent; every
 * other key is required, and a map that leaves one out is refused.
 */
export const countsField = <
  const Key extends string,
  const AddedKey extends Key,
  S extends Schema.Top,
>(
  keys: ReadonlyArray<Key>,
  addedKeys: ReadonlyArray<AddedKey>,
  count: S & { readonly Type: number }
) => {
  const added: ReadonlySet<string> = new Set(addedKeys);
  return Schema.Struct(
    Object.fromEntries(
      keys.map((key) => [
        key,
        added.has(key) ? fieldWithDefault(count, 0 as S["Type"]) : count,
      ])
    ) as {
      readonly [K in Key]: K extends AddedKey
        ? ReturnType<typeof fieldWithDefault<S>>
        : S;
    }
  );
};
