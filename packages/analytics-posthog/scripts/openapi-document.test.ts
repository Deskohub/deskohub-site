import { describe, expect, test } from "bun:test";
import { Option, Schema } from "effect";
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
  ])("rejects %s", (_case, paths) => {
    expect(Option.isNone(decode({ ...document, paths }))).toBeTrue();
  });

  test("rejects a document without info", () => {
    expect(
      Option.isNone(decode({ openapi: "3.1.0", paths: document.paths }))
    ).toBeTrue();
  });
});
