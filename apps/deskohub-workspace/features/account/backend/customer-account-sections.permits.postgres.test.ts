import "@/shared/testing/workspace-test-env";

import { afterAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { Duration, Effect, Exit, Layer } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { makeDatabaseClient, makeDatabasePool } from "@/db/database-client";
import { databasePoolTimeouts } from "@/db/database-pool-timeouts";
import { WorkspaceDatabaseAdvisoryLock } from "@/db/postgres-advisory-lock";
import { WorkspaceLockSections, WorkspaceLocks } from "@/db/workspace-locks";
import { dotyposCustomerIdSchema } from "@/features/reservation/dotypos-customer";
import {
  type WorkspaceReservationId,
  workspaceReservationIdSchema,
} from "@/features/reservation/persistence-contracts";
import { reservationCustomerEmailSchema } from "@/features/reservation/reservation-contact";
import { workspaceFixtures } from "@/shared/testing/workspace-fixtures.test-utils";
import { createWorkspacePostgresSuiteDatabase } from "@/shared/testing/workspace-postgres-test-database.test-utils";
import type { CustomerAccountId } from "../customer-account";
import { CustomerAccountLinkRepository } from "./customer-account-link.repository";
import { CustomerAccountSections } from "./customer-account-sections";
import {
  type CustomerAccountSession,
  CustomerAuthentication,
} from "./customer-authentication.service";
import { testSessionProfile } from "./customer-authentication.test-utils";

const suiteDatabase = await createWorkspacePostgresSuiteDatabase(
  "customer_account_section_permits"
);

/**
 * Submit-shaped work holding the account's and the order's sections on
 * pools small enough that section holders outnumber the advisory-lock
 * permits (half the pool). Every holder must finish: none may wait for a
 * second permit while holding one, and the transactions inside a section
 * must get the connections the sections leave free.
 */
describe.skipIf(!suiteDatabase)(
  "CustomerAccountSections on a small pool",
  () => {
    if (!suiteDatabase) return;

    afterAll(() => suiteDatabase.close());

    /** Submissions per order and viewer kind, above every pool's permits. */
    const submissionsPerOrder = 3;
    const orderCount = 2;

    const prepare = Effect.promise(() =>
      suiteDatabase.pool.query(
        "create table if not exists section_permit_attempts (order_id text primary key)"
      )
    );

    const seedAccount = () =>
      Effect.runPromise(
        workspaceFixtures(suiteDatabase.db).account("section-permits")
      );

    const sessionFor = (account: {
      readonly accountId: CustomerAccountId;
      readonly email: string;
    }): CustomerAccountSession => ({
      accountId: account.accountId,
      email: reservationCustomerEmailSchema.make(account.email),
      deletionRequested: false,
      ...testSessionProfile,
    });

    for (const max of [2, 4] as const) {
      test(`pool max ${max}: concurrent signed-in, anonymous and order-only holders all finish with one attempt per order`, async () => {
        await Effect.runPromise(prepare);
        const pool = makeDatabasePool({
          connectionString: suiteDatabase.pool.options.connectionString!,
          ...databasePoolTimeouts,
          max,
        });
        try {
          const db = await Effect.runPromise(makeDatabaseClient(pool));
          const databaseLayer = Layer.succeed(
            WorkspaceDatabase,
            WorkspaceDatabase.make(db)
          );
          const advisoryLock = WorkspaceDatabaseAdvisoryLock.makeLayer(pool);
          const sectionsFor = (session: CustomerAccountSession | null) =>
            CustomerAccountSections.Default.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(CustomerAuthentication, {
                    currentUser: Effect.succeed(session),
                  }),
                  CustomerAccountLinkRepository.Default.pipe(
                    Layer.provide(databaseLayer)
                  ),
                  advisoryLock
                )
              )
            );

          const orders = Array.from({ length: orderCount }, () =>
            workspaceReservationIdSchema.make(
              `permit-order-${crypto.randomUUID()}`
            )
          );
          const accounts = await Promise.all(orders.map(() => seedAccount()));

          /**
           * Admission-shaped: under the order's section, an ordinary
           * transaction reads whether the order has its attempt, then a
           * lock-taking transaction starts it. Without the order's
           * section two submissions would both insert and one would fail.
           */
          const submit = (order: WorkspaceReservationId) =>
            Effect.gen(function* () {
              const { transaction } = yield* WorkspaceDatabase;
              const { rows } = yield* transaction(
                db.execute<{ readonly started: boolean }>(
                  sql`select exists (select 1 from section_permit_attempts where order_id = ${order}) as started`
                )
              );
              if (rows[0]?.started) return "resolved" as const;
              yield* transaction(
                Effect.gen(function* () {
                  yield* WorkspaceLocks.referralGraph({
                    boundedWait: Duration.seconds(5),
                  });
                  yield* WorkspaceLocks.referralFirstBooking(
                    dotyposCustomerIdSchema.make(`customer-${order}`)
                  );
                  yield* db.execute(
                    sql`insert into section_permit_attempts (order_id) values (${order})`
                  );
                })
              );
              return "started" as const;
            });

          const signedIn = (index: number) =>
            CustomerAccountSections.pipe(
              Effect.flatMap((sections) =>
                sections.withOptionalAccount(() => submit(orders[index]!), {
                  reservationOrder: orders[index]!,
                })
              ),
              Effect.provide(sectionsFor(sessionFor(accounts[index]!)))
            );
          const anonymous = (index: number) =>
            CustomerAccountSections.pipe(
              Effect.flatMap((sections) =>
                sections.withOptionalAccount(() => submit(orders[index]!), {
                  reservationOrder: orders[index]!,
                })
              ),
              Effect.provide(sectionsFor(null))
            );
          /** Prepare-shaped: the order's section alone, reading the order. */
          const orderOnly = (index: number) =>
            WorkspaceLockSections.reservationOrder(orders[index]!)(
              Effect.flatMap(WorkspaceDatabase, ({ transaction }) =>
                transaction(
                  db.execute(
                    sql`select count(*) from section_permit_attempts where order_id = ${orders[index]!}`
                  )
                )
              )
            ).pipe(Effect.as("read" as const), Effect.provide(advisoryLock));

          const holders = orders.flatMap((_, index) =>
            Array.from({ length: submissionsPerOrder }, () => [
              signedIn(index),
              anonymous(index),
              orderOnly(index),
            ]).flat()
          );
          expect(holders.length).toBeGreaterThan(Math.floor(max / 2));

          const exit = await Effect.runPromiseExit(
            Effect.all(holders, { concurrency: "unbounded" }).pipe(
              Effect.provide(databaseLayer),
              Effect.timeout("30 seconds")
            )
          );

          expect(Exit.isSuccess(exit)).toBe(true);
          if (!Exit.isSuccess(exit)) return;
          expect(
            exit.value.filter((outcome) => outcome === "started")
          ).toHaveLength(orderCount);
          const { rows } = await suiteDatabase.pool.query<{
            readonly order_id: string;
          }>(
            "select order_id from section_permit_attempts where order_id = any($1)",
            [orders]
          );
          expect(rows.map(({ order_id }) => order_id).sort()).toEqual(
            [...orders].sort()
          );
        } finally {
          await pool.end();
        }
      }, 60_000);
    }
  }
);
