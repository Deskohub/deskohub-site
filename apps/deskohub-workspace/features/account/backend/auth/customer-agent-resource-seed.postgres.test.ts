import "@/shared/testing/workspace-test-env";

import { describe, expect, test } from "bun:test";
import { Predicate } from "effect";
import type { Pool, QueryConfig } from "pg";
import {
  type CapturedMagicLink,
  callHandler,
  cookieJar,
  getSessionCookie,
  HOST,
  makeTestAuth,
  signInForMagicLink,
  type TestAuth,
  testDatabase,
  uniqueEmail,
  verifyMagicLink,
} from "./auth-handler.test-utils";

/**
 * The test pool, except that reads of the OAuth resource table time out
 * while `timingOut` is set. Counts every resource read.
 */
const resourceReadsTimingOut = (pool: Pool) => {
  const resource = { reads: 0, timingOut: true };
  const query = (config: string | QueryConfig, values?: unknown[]) => {
    const text = Predicate.isString(config) ? config : config.text;
    if (!text.includes("oauth_resource")) return pool.query(config, values);
    resource.reads += 1;
    return resource.timingOut
      ? Promise.reject(new Error("Query read timeout"))
      : pool.query(config, values);
  };
  const proxy = new Proxy(pool, {
    get: (target, property) => {
      if (property === "query") return query;
      const value = Reflect.get(target, property, target);
      return Predicate.isFunction(value) ? value.bind(target) : value;
    },
  });
  return { pool: proxy, resource };
};

const signIn = async (auth: TestAuth, sentLinks: CapturedMagicLink[]) => {
  const before = sentLinks.length;
  await signInForMagicLink(auth, uniqueEmail("resource-seed"));
  const setCookie = getSessionCookie(
    await verifyMagicLink(auth, sentLinks[before]!)
  );
  expect(setCookie).toBeDefined();
  return cookieJar(setCookie!);
};

/**
 * Registers a client, which looks the MCP resource up as a default resource
 * of every registration. Answers how the registration ended.
 */
const registerClient = (auth: TestAuth, cookie: string) =>
  auth.api
    .adminCreateOAuthClient({
      headers: new Headers({ cookie, host: HOST }),
      body: {
        client_name: "Resource Seed Agent",
        redirect_uris: [`https://seed.example/${crypto.randomUUID()}/callback`],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      },
    })
    .then(
      () => "registered",
      (error: Error) => error.name
    );

// The OAuth provider seeds the MCP resource row on an instance's first
// resource lookup. Deployments start before migrations run (a preview is
// Ready before its database is migrated), so a missing OAuth table must defer
// the seed, not fail the auth requests of the instance. The Drizzle adapter wraps the
// Postgres error, which the patched provider reads through `cause`.
describe.skipIf(!testDatabase)(
  "customer agent resource seed before the OAuth migration",
  () => {
    test("starts and serves auth while the resource table is missing", async () => {
      await testDatabase!.pool.query(
        "alter table auth.oauth_resource rename to oauth_resource_pending"
      );
      try {
        const auth = makeTestAuth();

        const ok = await callHandler(auth, "/ok");
        expect(ok.status).toBe(200);
        const session = await callHandler(auth, "/get-session");
        expect(session.status).toBe(200);
      } finally {
        await testDatabase!.pool.query(
          "alter table auth.oauth_resource_pending rename to oauth_resource"
        );
      }
    });

    // Better Auth keeps the promise of its startup for the instance's
    // lifetime, so a resource read at startup that times out would fail
    // every later request. The first resource lookup seeds instead, and a
    // failed seed is retried on the next lookup.
    test("starts without reading the resource and recovers from a seed that timed out", async () => {
      const database = resourceReadsTimingOut(testDatabase!.pool);
      const sentLinks: CapturedMagicLink[] = [];
      const auth = makeTestAuth({
        postgres: { ...testDatabase!, pool: database.pool },
        sentLinks,
      });

      await auth.$context;
      expect(database.resource.reads).toBe(0);
      const cookie = await signIn(auth, sentLinks);

      expect(await registerClient(auth, cookie)).toBe("DrizzleQueryError");
      expect(database.resource.reads).toBe(1);

      database.resource.timingOut = false;
      expect(await registerClient(auth, cookie)).toBe("registered");
    });
  }
);
