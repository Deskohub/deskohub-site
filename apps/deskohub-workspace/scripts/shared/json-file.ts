import { readFileSync } from "node:fs";
import { Schema } from "effect";

/** Reads the JSON file at `path` and decodes it with `schema`. */
export const readJsonFile = <S extends Schema.Decoder<unknown>>(
  schema: S,
  path: string
): S["Type"] =>
  Schema.decodeUnknownSync(Schema.fromJsonString(schema))(
    readFileSync(path, "utf8")
  );
