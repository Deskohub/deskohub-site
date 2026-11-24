import { Schema } from "effect";

/**
 * A reflected Administration API schema as the codec it is. This is a trust
 * boundary, not a proof: reflection types every endpoint schema as
 * `Schema.Top`, whose services are unknown, and Effect has no checked way to
 * rebuild a service-free codec from one. The contract's schemas decode and
 * encode without services. The codec keeps the schema's own AST, so it parses
 * exactly as the schema does.
 */
export const administrationContractCodec = (schema: Schema.Top) =>
  Schema.make<Schema.Codec<unknown, unknown>>(schema.ast);
