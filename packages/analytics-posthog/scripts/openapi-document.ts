import { Schema } from "effect";
import type { OpenAPISpec } from "effect/http-api/OpenApi";

const JsonObject = Schema.Record(Schema.String, Schema.Json);

const SecurityRequirements = Schema.Array(
  Schema.Record(Schema.String, Schema.Array(Schema.String))
);

const ExternalDocs = Schema.Struct({
  description: Schema.optionalKey(Schema.String),
  url: Schema.String,
});

/**
 * Every operation field the generator reads. Parameters, request bodies and
 * responses may be `$ref`s the generator resolves, so they stay JSON objects.
 */
const OpenApiOperation = Schema.Struct({
  deprecated: Schema.optionalKey(Schema.Boolean),
  description: Schema.optionalKey(Schema.String),
  externalDocs: Schema.optionalKey(ExternalDocs),
  operationId: Schema.optionalKey(Schema.String),
  parameters: Schema.optionalKey(Schema.Array(JsonObject)),
  requestBody: Schema.optionalKey(JsonObject),
  responses: Schema.optionalKey(Schema.Record(Schema.String, JsonObject)),
  security: Schema.optionalKey(SecurityRequirements),
  summary: Schema.optionalKey(Schema.String),
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
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
  query: Schema.optionalKey(OpenApiOperation),
  trace: Schema.optionalKey(OpenApiOperation),
  "x-oai-additionalOperations": Schema.optionalKey(
    Schema.Record(Schema.String, OpenApiOperation)
  ),
});

/**
 * Every field `@effect/openapi-generator` reads from a document, typed the
 * way the generator reads it: optional where it falls back, and each schema,
 * parameter, request body and response left as JSON for it to resolve.
 *
 * Effect publishes the generator's input as `OpenAPISpec`, the type of the
 * documents `OpenApi.fromApi` emits. That type is stricter than the
 * documents the generator accepts: PostHog's schema has `$ref` parameters,
 * optional request bodies, and operations without `security`, all of which
 * the generator resolves or defaults. Decoding into `OpenAPISpec` itself
 * would reject that schema, and filling its required fields would change the
 * generated client, so this shape checks the generator's real input instead.
 */
const OpenApiDocumentShape = Schema.Struct({
  components: Schema.optionalKey(
    Schema.Struct({
      schemas: Schema.optionalKey(JsonObject),
      securitySchemes: Schema.optionalKey(JsonObject),
    })
  ),
  info: Schema.Struct({
    description: Schema.optionalKey(Schema.String),
    license: Schema.optionalKey(
      Schema.Struct({
        name: Schema.String,
        url: Schema.optionalKey(Schema.String),
      })
    ),
    summary: Schema.optionalKey(Schema.String),
    title: Schema.String,
    version: Schema.String,
  }),
  openapi: Schema.String,
  paths: Schema.Record(Schema.String, OpenApiPathItem),
  security: Schema.optionalKey(SecurityRequirements),
  servers: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        description: Schema.optionalKey(Schema.String),
        url: Schema.String,
      })
    )
  ),
  tags: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        description: Schema.optionalKey(Schema.String),
        externalDocs: Schema.optionalKey(ExternalDocs),
        name: Schema.String,
      })
    )
  ),
});

const isOpenApiDocument = Schema.is(OpenApiDocumentShape);

/** A JSON document whose structure the OpenAPI generator can walk. */
export const OpenApiDocument = Schema.declare<OpenAPISpec>(
  (document): document is OpenAPISpec => isOpenApiDocument(document)
);
