import { and, eq, isNull } from "drizzle-orm";
import { Data, Effect, Option } from "effect";
import { WorkspaceDatabase, WorkspaceTransaction } from "@/db/database.service";
import { authUser } from "@/db/schema/auth";
import { customerAccounts } from "@/db/schema/customer-accounts";
import {
  type CustomerAccountId,
  customerAccountIdSchema,
} from "../customer-account";
import { ensureCustomerAccount } from "./customer-account.repository";

type ActiveCustomerAccount = {
  readonly accountId: CustomerAccountId;
  /** The login email, as stored. */
  readonly email: string;
};

/**
 * Finds the active account that signs in with `email`, with its stored login
 * email. Accounts with an unverified email or a pending deletion yield none.
 */
export const findActiveCustomerAccountByEmail = Effect.fn(
  "CustomerAccount.findActiveByEmail"
)(function* (email: string) {
  const { db } = yield* WorkspaceDatabase;
  const [row] = yield* db
    .select({ id: authUser.id, email: authUser.email })
    .from(authUser)
    .where(
      and(
        // Better Auth stores login emails lowercased.
        eq(authUser.email, email.trim().toLowerCase()),
        eq(authUser.emailVerified, true),
        isNull(authUser.deletionRequestedAt)
      )
    )
    .limit(1);
  return Option.fromNullishOr(row).pipe(
    Option.map(
      (account): ActiveCustomerAccount => ({
        accountId: customerAccountIdSchema.make(account.id),
        email: account.email,
      })
    )
  );
});

/** A pass can name a holder before the holder verifies their login. */
export const findPassHolderAccount = Effect.fn(
  "CustomerAccount.findPassHolder"
)(function* (email: string) {
  const { db } = yield* WorkspaceDatabase;
  const [holder] = yield* db
    .select({ id: customerAccounts.id })
    .from(authUser)
    .innerJoin(customerAccounts, eq(customerAccounts.id, authUser.id))
    .where(
      and(
        eq(authUser.email, email.trim().toLowerCase()),
        isNull(authUser.deletionRequestedAt),
        isNull(customerAccounts.deletedAt)
      )
    );
  return holder?.id;
});

class LoginEmailAlreadyExists extends Data.TaggedError(
  "LoginEmailAlreadyExists"
) {}

/**
 * Reuse the holder's login, or provision an unverified one with no session or
 * Dotypos link. The caller's purchase transaction owns both new records.
 */
export const ensurePassHolderAccount = Effect.fn(
  "CustomerAccount.ensurePassHolder"
)(function* (email: string) {
  yield* WorkspaceTransaction;
  const { transaction } = yield* WorkspaceDatabase;
  const existing = yield* findPassHolderAccount(email);
  if (existing) return existing;

  const accountId = customerAccountIdSchema.make(crypto.randomUUID());
  return yield* transaction(
    Effect.gen(function* () {
      const { db } = yield* WorkspaceTransaction;
      yield* ensureCustomerAccount(accountId);
      const [created] = yield* db
        .insert(authUser)
        .values({ id: accountId, email: email.trim().toLowerCase(), name: "" })
        .onConflictDoNothing({ target: authUser.email })
        .returning({ id: authUser.id });
      if (!created) return yield* new LoginEmailAlreadyExists();
      return accountId;
    })
  ).pipe(
    Effect.catchTag("LoginEmailAlreadyExists", () =>
      findPassHolderAccount(email)
    )
  );
});
