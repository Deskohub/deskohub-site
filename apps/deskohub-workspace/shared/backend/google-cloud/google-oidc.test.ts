import { afterAll, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  serveGoogleSigningKeys,
  tasksInvoker,
} from "@/shared/testing/google-oidc.test-utils";
import { authenticateGoogleInvoker, GoogleIdentityKeys } from "./google-oidc";

// Google's certificate URL fails, so only the injected keys can verify.
const google = await serveGoogleSigningKeys("network-error");
afterAll(() => google.restore());

const authenticate = (authorization: string) =>
  authenticateGoogleInvoker(
    new Request("https://tasks-worker.workspace.test/", {
      headers: { authorization },
    }),
    tasksInvoker
  ).pipe(
    Effect.provideService(GoogleIdentityKeys, google.keys),
    Effect.match({
      onFailure: ({ status, reason }) => ({ status, reason }),
      onSuccess: () => "authenticated" as const,
    }),
    Effect.runPromise
  );

test("verifies with the injected key set", async () => {
  expect(await authenticate(`Bearer ${await google.token(tasksInvoker)}`)).toBe(
    "authenticated"
  );
});

test("rejects a token the injected keys don't verify", async () => {
  expect(
    await authenticate(
      `Bearer ${await google.token(tasksInvoker, {}, "foreign")}`
    )
  ).toEqual({ status: 401, reason: "invalid-token" });
});
