import "@/shared/testing/workspace-test-env";

import { describe, expect, test } from "bun:test";
import {
  type CapturedMagicLink,
  callHandler,
  cookieJar,
  getSessionCookie,
  HOST,
  makeTestAuth,
  observedPool,
  signInForMagicLink,
  type TestAuth,
  testDatabase,
  uniqueEmail,
  verifyMagicLink,
} from "./auth-handler.test-utils";

const RESOURCE = `https://${HOST}/api/mcp`;

const isResourceQuery = (sql: string) => sql.includes("oauth_resource");

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

const withResourceTableMissing = async (run: () => Promise<void>) => {
  await testDatabase!.pool.query(
    "alter table auth.oauth_resource rename to oauth_resource_pending"
  );
  try {
    await run();
  } finally {
    await testDatabase!.pool.query(
      "alter table auth.oauth_resource_pending rename to oauth_resource"
    );
  }
};

// The OAuth provider seeds the MCP resource row on an instance's first
// resource lookup. Deployments start before migrations run (a preview is
// Ready before its database is migrated), so a missing OAuth table must defer
// the seed, not fail the auth requests of the instance. The Drizzle adapter
// wraps the Postgres error, which the patched provider reads through `cause`.
describe.skipIf(!testDatabase)(
  "customer agent resource seed before the OAuth migration",
  () => {
    test("starts and serves auth while the resource table is missing", async () => {
      await withResourceTableMissing(async () => {
        const auth = makeTestAuth();

        const ok = await callHandler(auth, "/ok");
        expect(ok.status).toBe(200);
        const session = await callHandler(auth, "/get-session");
        expect(session.status).toBe(200);
      });
    });

    test("seeds the resource on the first lookup after the migration", async () => {
      const sentLinks: CapturedMagicLink[] = [];
      const auth = makeTestAuth({ sentLinks });
      const cookie = await signIn(auth, sentLinks);

      await withResourceTableMissing(async () => {
        expect(await registerClient(auth, cookie)).not.toBe("registered");
      });
      // Only the seed can bring the row back.
      await testDatabase!.pool.query(
        "delete from auth.oauth_resource where identifier = $1",
        [RESOURCE]
      );

      expect(await registerClient(auth, cookie)).toBe("registered");
    });

    // Better Auth keeps the promise of its startup for the instance's
    // lifetime, so a resource read at startup that times out would fail
    // every later request. The first resource lookup seeds instead, and a
    // failed seed is retried on the next lookup.
    test("starts without reading the resource and recovers from a seed that timed out", async () => {
      const database = observedPool(testDatabase!.pool);
      database.observed.failing = isResourceQuery;
      const resourceReads = () =>
        database.observed.queries.filter(isResourceQuery).length;
      const sentLinks: CapturedMagicLink[] = [];
      const auth = makeTestAuth({
        postgres: { ...testDatabase!, pool: database.pool },
        sentLinks,
      });

      await auth.$context;
      expect(resourceReads()).toBe(0);
      const cookie = await signIn(auth, sentLinks);

      expect(await registerClient(auth, cookie)).toBe("DrizzleQueryError");
      expect(resourceReads()).toBe(1);

      database.observed.failing = () => false;
      expect(await registerClient(auth, cookie)).toBe("registered");
    });
  }
);
