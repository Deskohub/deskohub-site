import "@/shared/testing/workspace-test-env";

import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { customerAccounts } from "@/db/schema";
import { authUser } from "@/db/schema/auth";
import { CustomerAccountRepository } from "@/features/account/backend/customer-account.repository";
import { customerAccountIdSchema } from "@/features/account/customer-account";
import { workspaceFixtures } from "@/shared/testing/workspace-fixtures.test-utils";
import { connectWorkspacePostgresTestDatabase } from "@/shared/testing/workspace-postgres-test-database.test-utils";
import { E2EDatabase } from "../integrations/database.service";
import { verifyUnlimitedRecoveryBuyer } from "../playwright-checkout/unlimited-pass-recovery-evidence";
import { removeSyntheticAuthUser } from "./auth-rows";

const testDatabase = await connectWorkspacePostgresTestDatabase();

const insertAuthUser = (id: string) =>
  workspaceFixtures(testDatabase!.db)
    .account("auth-rows", { id: customerAccountIdSchema.make(id) })
    .pipe(Effect.runPromise);

const removeAccount = (accountId: string) =>
  removeSyntheticAuthUser(accountId).pipe(
    Effect.provideService(
      E2EDatabase,
      E2EDatabase.of({ db: testDatabase!.db })
    ),
    Effect.runPromise
  );

/** The tombstone's deletion instant, null while active, undefined when absent. */
const readDeletedAt = async (accountId: string) => {
  const [row] = await testDatabase!.db
    .select({ deletedAt: customerAccounts.deletedAt })
    .from(customerAccounts)
    .where(eq(customerAccounts.id, accountId))
    .pipe(Effect.runPromise);
  return row === undefined ? undefined : (row.deletedAt?.toString() ?? null);
};

const authUserExists = async (accountId: string) => {
  const rows = await testDatabase!.db
    .select({ id: authUser.id })
    .from(authUser)
    .where(eq(authUser.id, accountId))
    .pipe(Effect.runPromise);
  return rows.length > 0;
};

describe.skipIf(!testDatabase)(
  "Synthetic account removal on disposable Postgres",
  () => {
    test("tombstones the customer account and deletes the Better Auth user", async () => {
      const accountId = `agent-eval-${crypto.randomUUID()}`;
      await insertAuthUser(accountId);
      expect(await readDeletedAt(accountId)).toBeNull();

      await removeAccount(accountId);

      expect(await readDeletedAt(accountId)).toEqual(expect.any(String));
      expect(await authUserExists(accountId)).toBe(false);
    });

    test("leaves a tombstone for an unlinked account", async () => {
      const accountId = crypto.randomUUID();
      await insertAuthUser(accountId);

      await removeAccount(accountId);

      expect(await readDeletedAt(accountId)).toEqual(expect.any(String));
      expect(await authUserExists(accountId)).toBe(false);
    });

    test("keeps the first deletion instant when cleanup repeats", async () => {
      const accountId = crypto.randomUUID();
      await insertAuthUser(accountId);
      await removeAccount(accountId);
      const firstDeletedAt = await readDeletedAt(accountId);

      await removeAccount(accountId);

      expect(await readDeletedAt(accountId)).toBe(firstDeletedAt);
    });

    test("resumes an original buyer tombstoned before its login was removed", async () => {
      const accountId = `agent-eval-${crypto.randomUUID()}`;
      await insertAuthUser(accountId);
      const { db } = testDatabase!;
      const [login] = await Effect.runPromise(
        db.select().from(authUser).where(eq(authUser.id, accountId))
      );
      if (!login) throw new Error("Synthetic buyer login missing");

      await CustomerAccountRepository.use((accounts) =>
        accounts.tombstone(
          customerAccountIdSchema.make(accountId),
          Temporal.Now.instant()
        )
      ).pipe(
        Effect.provide(CustomerAccountRepository.Default),
        Effect.provideService(WorkspaceDatabase, WorkspaceDatabase.make(db)),
        Effect.runPromise
      );
      const firstDeletedAt = await readDeletedAt(accountId);
      expect(firstDeletedAt).toBeString();
      expect(await authUserExists(accountId)).toBe(true);

      const buyer = verifyUnlimitedRecoveryBuyer({
        authEmail: login.email,
        customerId: "original-provider-profile",
        linkedCustomerId: null,
        recipient: login.email,
        tombstoned: true,
      });
      expect(buyer.expireProfile).toBe(false);
      expect(buyer.removeLogin).toBe(true);
      if (buyer.removeLogin) await removeAccount(accountId);
      expect(await authUserExists(accountId)).toBe(false);
      expect(await readDeletedAt(accountId)).toBe(firstDeletedAt);
    });
  }
);
