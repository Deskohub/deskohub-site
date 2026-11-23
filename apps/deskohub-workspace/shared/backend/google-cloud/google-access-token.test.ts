import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import {
  GoogleAccessToken,
  MetadataServerGoogleAccessToken,
  metadataServerTokenUrl,
} from "./google-access-token";

type TokenRequest = { readonly url: string; readonly headers: Headers };

const withMetadataServer = <A, E>(
  respond: (count: number) => Response,
  run: (token: Effect.Effect<string, unknown>) => Effect.Effect<A, E>
) => {
  const requests: TokenRequest[] = [];
  const fetch = Object.assign(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(url), headers: new Headers(init?.headers) });
      return respond(requests.length);
    },
    { preconnect: globalThis.fetch.preconnect }
  );
  return Effect.gen(function* () {
    const { get } = yield* GoogleAccessToken;
    return yield* run(get);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(MetadataServerGoogleAccessToken, TestClock.layer())
    ),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
    Effect.result,
    Effect.runPromise,
    (result) => result.then((outcome) => ({ outcome, requests }))
  );
};

const tokenResponse = (count: number) =>
  Response.json({
    access_token: `token-${count}`,
    expires_in: 3600,
    token_type: "Bearer",
  });

describe("MetadataServerGoogleAccessToken", () => {
  test("asks the metadata server for the service account token", async () => {
    const { outcome, requests } = await withMetadataServer(
      tokenResponse,
      (get) => get
    );

    expect(outcome).toMatchObject({ success: "token-1" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(metadataServerTokenUrl);
    expect(requests[0]?.headers.get("metadata-flavor")).toBe("Google");
  });

  test("reuses the token until shortly before it expires", async () => {
    const { outcome, requests } = await withMetadataServer(
      tokenResponse,
      (get) =>
        Effect.gen(function* () {
          const first = yield* get;
          yield* TestClock.adjust("58 minutes");
          const reused = yield* get;
          yield* TestClock.adjust("1 minute");
          const refreshed = yield* get;
          return [first, reused, refreshed];
        })
    );

    expect(outcome).toMatchObject({
      success: ["token-1", "token-1", "token-2"],
    });
    expect(requests).toHaveLength(2);
  });

  test("shares one refresh between concurrent callers", async () => {
    const { outcome, requests } = await withMetadataServer(
      tokenResponse,
      (get) => Effect.all([get, get, get], { concurrency: "unbounded" })
    );

    expect(outcome).toMatchObject({
      success: ["token-1", "token-1", "token-1"],
    });
    expect(requests).toHaveLength(1);
  });

  test("fails on an error status and retries on the next call", async () => {
    const { outcome, requests } = await withMetadataServer(
      (count) =>
        count === 1
          ? new Response(null, { status: 503 })
          : tokenResponse(count),
      (get) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(get);
          const token = yield* get;
          return { failure, token };
        })
    );

    expect(outcome).toMatchObject({
      success: {
        failure: {
          _tag: "GoogleAccessTokenError",
          reason: "status",
          httpStatus: 503,
        },
        token: "token-2",
      },
    });
    expect(requests).toHaveLength(2);
  });

  test("fails on an unreadable token response", async () => {
    const { outcome } = await withMetadataServer(
      () => Response.json({ token_type: "Bearer" }),
      (get) => get
    );

    expect(outcome).toMatchObject({
      failure: { _tag: "GoogleAccessTokenError", reason: "invalid-response" },
    });
  });
});
