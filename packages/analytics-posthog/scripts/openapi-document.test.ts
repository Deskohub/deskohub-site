import { describe, expect, test } from "bun:test";
import * as OpenApiGenerator from "@effect/openapi-generator/OpenApiGenerator";
import { Effect, Option, Schema } from "effect";
import { OpenApiDocument } from "./openapi-document";

const decode = Schema.decodeUnknownOption(OpenApiDocument);

const document = {
  openapi: "3.1.0",
  info: { title: "PostHog", version: "1.0.0" },
  paths: {
    "/flags": {
      get: {
        parameters: [{ name: "limit", in: "query" }],
        responses: { "200": { description: "OK" } },
      },
    },
  },
  components: { schemas: { Flag: { type: "object" } } },
};

describe("OpenApiDocument", () => {
  test("accepts a document the generator can walk", () => {
    expect(Option.isSome(decode(document))).toBeTrue();
  });

  test.each([
    ["a path item that is not an object", { "/flags": null }],
    ["an operation that is not an object", { "/flags": { get: "list" } }],
    [
      "parameters that are not objects",
      { "/flags": { get: { parameters: [null] } } },
    ],
    [
      "a response that is not an object",
      { "/flags": { get: { responses: { "200": 1 } } } },
    ],
    ["operation tags that are not strings", { "/flags": { get: { tags: 1 } } }],
    [
      "operation security that is not a requirement list",
      { "/flags": { get: { security: [1] } } },
    ],
  ])("rejects %s", (_case, paths) => {
    expect(Option.isNone(decode({ ...document, paths }))).toBeTrue();
  });

  test("generates a client from a decoded document", async () => {
    const source = await Effect.runPromise(
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeUnknownEffect(OpenApiDocument)({
          openapi: "3.1.0",
          info: { title: "Flags", version: "1.0.0" },
          paths: {
            "/flags": {
              get: {
                operationId: "listFlags",
                tags: ["flags"],
                responses: {
                  "200": {
                    description: "OK",
                    content: {
                      "application/json": {
                        schema: { $ref: "#/components/schemas/Flag" },
                      },
                    },
                  },
                },
              },
            },
          },
          components: {
            schemas: {
              Flag: {
                type: "object",
                required: ["key"],
                properties: { key: { type: "string" } },
              },
            },
          },
        });
        const generator = yield* OpenApiGenerator.OpenApiGenerator;
        return yield* generator.generate(decoded, {
          format: "httpclient",
          name: "FlagsClient",
        });
      }).pipe(Effect.provide(OpenApiGenerator.layerTransformerSchema))
    );

    expect(source).toContain("listFlags");
    expect(source).toContain("FlagsClient");
  });

  test("rejects a document without info", () => {
    expect(
      Option.isNone(decode({ openapi: "3.1.0", paths: document.paths }))
    ).toBeTrue();
  });
});
