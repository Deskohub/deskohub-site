import { Schema } from "effect";
import type { OpenAPISpec } from "effect/http-api/OpenApi";

const JsonObject = Schema.Record(Schema.String, Schema.Json);

const OpenApiOperation = Schema.Struct({
  parameters: Schema.optionalKey(Schema.Array(JsonObject)),
  responses: Schema.optionalKey(Schema.Record(Schema.String, JsonObject)),
});

const OpenApiPathItem = Schema.Struct({
  delete: Schema.optionalKey(OpenApiOperation),
  get: Schema.optionalKey(OpenApiOperation),
  head: Schema.optionalKey(OpenApiOperation),
  options: Schema.optionalKey(OpenApiOperation),
  parameters: Schema.optionalKey(Schema.Array(JsonObject)),
  patch: Schema.optionalKey(OpenApiOperation),
  post: Schema.optionalKey(OpenApiOperation),
  put: Schema.optionalKey(OpenApiOperation),
  trace: Schema.optionalKey(OpenApiOperation),
});

/**
 * The structure the OpenAPI generator walks: document info, path items and
 * their operations, and component schemas. Each schema and parameter body
 * stays JSON for the generator to parse.
 */
const OpenApiDocumentShape = Schema.Struct({
  components: Schema.optionalKey(
    Schema.Struct({ schemas: Schema.optionalKey(JsonObject) })
  ),
  info: Schema.Struct({ title: Schema.String, version: Schema.String }),
  openapi: Schema.String,
  paths: Schema.Record(Schema.String, OpenApiPathItem),
});

const isOpenApiDocument = Schema.is(OpenApiDocumentShape);

/** A JSON document whose structure the OpenAPI generator can walk. */
export const OpenApiDocument = Schema.declare<OpenAPISpec>(
  (document): document is OpenAPISpec => isOpenApiDocument(document)
);
