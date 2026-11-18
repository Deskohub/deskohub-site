import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { testEmailAddress } from "@deskohub/test-email";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fixtureReservationAuthorId as buyer } from "@/shared/testing/workspace-fixtures.test-utils";
import {
  linkMigrationsBefore,
  withScratchDatabase,
  workspaceMigrationsFolder,
} from "../migration-scratch-database.test-utils";

const databaseUrl = process.env.WORKSPACE_TEST_DATABASE_URL;
const migration = "20261118233751_pass_holder_accounts";

describe.skipIf(!databaseUrl)("pass holder accounts migration", () => {
  test("preserves existing holders and moves pending holder addresses to unverified logins", async () => {
    const earlierMigrations = await linkMigrationsBefore(migration);
    try {
      await withScratchDatabase(
        databaseUrl!,
        "pass_holder_migration",
        async (pool) => {
          const db = drizzle({ client: pool });
          await migrate(db, { migrationsFolder: earlierMigrations });
          const buyerEmail = testEmailAddress("migration-pass-buyer");
          const holderEmail = testEmailAddress("migration-pass-holder");
          await pool.query("insert into customer_accounts (id) values ($1)", [
            buyer,
          ]);
          await pool.query(
            "insert into auth.\"user\" (id, name, email, email_verified) values ($1, '', $2, true)",
            [buyer, buyerEmail]
          );
          await pool.query(
            `with created as (
             insert into orders (kind, dotypos_customer_id, payment_state, fulfillment_state)
             select 'pass-purchase', 'fixture-buyer', 'not_started', 'not_started'
             from generate_series(1, 3)
             returning id
           )
           insert into pass_purchases
             (id, buyer_account_id, holder_account_id, holder_email, product, tier, entry_count, status, valid_from, valid_until, quote, locale, created_at)
           select id, $1, case when row = 1 then $1 end,
             case when row > 1 then (case when row = 2 then $2 else upper($2) end) end,
             'entry-pack', 'open-space', 5, 'pending_payment', '2026-11-18', '2027-01-18', '{}', 'en-US', now()
           from (select id, row_number() over () as row from created) as ordered`,
            [buyer, holderEmail]
          );

          await migrate(db, { migrationsFolder: workspaceMigrationsFolder });
          const { rows } = await pool.query(
            `select login.email, login.email_verified, count(*)::integer as purchases
           from pass_purchases pass
           join auth."user" login on login.id = pass.holder_account_id
           group by login.email, login.email_verified`
          );
          expect(rows).toHaveLength(2);
          expect(rows).toContainEqual({
            email: buyerEmail,
            email_verified: true,
            purchases: 1,
          });
          expect(rows).toContainEqual({
            email: holderEmail,
            email_verified: false,
            purchases: 2,
          });
        }
      );
    } finally {
      await rm(earlierMigrations, { recursive: true, force: true });
    }
  });
});
