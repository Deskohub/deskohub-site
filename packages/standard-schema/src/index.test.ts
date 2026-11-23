import { describe, expect, test } from "bun:test";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { decodeStandardSchema, parseStandardSchema } from "./index";

describe("standard-schema helpers", () => {
  test("rejects asynchronous schemas", () => {
    const asyncSchema: StandardSchemaV1<unknown, string> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: async () => ({ value: "later" }),
      },
    };

    expect(() => decodeStandardSchema(asyncSchema, "value")).toThrow(
      "Async Standard Schema validation is not supported here"
    );
  });

  test("returns synchronous results that carry a non-callable then", () => {
    const result = { value: "ok" };
    Reflect.set(result, "then", false);
    const syncSchema: StandardSchemaV1<unknown, string> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => result,
      },
    };

    expect(decodeStandardSchema(syncSchema, "value")).toBe("ok");
    expect(parseStandardSchema(syncSchema, "value", "invalid")).toBe("ok");
  });
});
