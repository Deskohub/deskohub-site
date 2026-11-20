import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  OpenApi,
} from "effect/http-api";
import { responseHeaders } from "./openapi-response-headers";

describe("responseHeaders", () => {
  test("refuses a status the endpoint doesn't answer", () => {
    const download = HttpApiEndpoint.get("download", "/download", {
      success: Schema.String,
    }).annotateMerge(
      responseHeaders(201, {
        "X-File-Name": { description: "The name." },
      })
    );
    const api = HttpApi.make("test").add(
      HttpApiGroup.make("files").add(download)
    );

    expect(() => OpenApi.fromApi(api)).toThrow(
      "files.download has no 201 response to describe headers on"
    );
  });
});
