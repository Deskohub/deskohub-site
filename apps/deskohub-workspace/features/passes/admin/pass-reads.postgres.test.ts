import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DotyposCustomerIdSchema } from "@deskohub/dotypos";
import { testEmailAddress } from "@deskohub/test-email";
import { Effect, Layer } from "effect";
import { AdministrationCustomerDirectory } from "@/features/administration/customer-directory.service";
import { orderIdSchema } from "@/features/order";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import {
  createWorkspacePostgresSuiteDatabase,
  type WorkspacePostgresSuiteDatabase,
} from "@/shared/testing/workspace-postgres-test-database.test-utils";
import {
  listAdminPasses,
  readAdminCustomerPasses,
  readAdminPass,
  readReservationPassLinks,
} from "./pass-reads";

describe.skipIf(!process.env.WORKSPACE_TEST_DATABASE_URL)(
  "Administration pass projections on disposable PostgreSQL",
  () => {
    let database: WorkspacePostgresSuiteDatabase;
    const passId = orderIdSchema.make(crypto.randomUUID());
    const unlimitedId = orderIdSchema.make(crypto.randomUUID());
    const buyerId = DotyposCustomerIdSchema.make("pass-admin-test-buyer");
    const holderId = DotyposCustomerIdSchema.make("pass-admin-test-holder");
    const buyerAccount = crypto.randomUUID();
    const holderAccount = crypto.randomUUID();
    const invitedAccount = crypto.randomUUID();
    const invitationEmail = testEmailAddress("admin-pass-invite");
    const winner = crypto.randomUUID();
    const extraCapture = crypto.randomUUID();
    const reservedDate = "2099-06-01";
    let packReservationId: ReturnType<typeof workspaceReservationIdSchema.make>;
    let dayReservationId: ReturnType<typeof workspaceReservationIdSchema.make>;
    const providerDirectory = Layer.mock(AdministrationCustomerDirectory, {
      findMany: () => Effect.succeed(new Map()),
      search: () =>
        Effect.die(new Error("No directory required for these fixtures")),
    });

    const run = <A, E>(
      read: Effect.Effect<
        A,
        E,
        | AdministrationCustomerDirectory
        | import("@/db/database.service").WorkspaceDatabase
      >
    ) =>
      Effect.runPromise(
        read.pipe(
          Effect.provide(providerDirectory),
          Effect.provide(database.layer)
        )
      );

    beforeAll(async () => {
      database = (await createWorkspacePostgresSuiteDatabase(
        "admin_pass_reads"
      ))!;
      const { pool } = database;
      await pool.query(
        "insert into customer_accounts (id, dotypos_customer_id) values ($1, $2), ($3, $4), ($5, null)",
        [buyerAccount, buyerId, holderAccount, holderId, invitedAccount]
      );
      await pool.query(
        "insert into auth.\"user\" (id, name, email) values ($1, '', $2)",
        [invitedAccount, invitationEmail]
      );
      await pool.query(
        `insert into orders
          (id, kind, dotypos_customer_id, payment_state, fulfillment_state,
           active_payment_attempt_id, paid_at, fulfilled_at)
         values
          ($1, 'pass-purchase', 'old-billing-customer', 'paid', 'fulfilled', $3, now(), now()),
          ($2, 'pass-purchase', 'old-billing-customer', 'paid', 'fulfilled', null, now(), now())`,
        [passId, unlimitedId, winner]
      );
      await pool.query(
        `insert into pass_purchases
          (id, buyer_account_id, holder_account_id, product, tier, entry_count,
           status, valid_from, valid_until, quote, locale, created_at, unlimited_coffee)
         values
          ($1, $3, $4, 'entry-pack', 'open-space', 5, 'active', '2024-06-01',
            '2024-07-01', '{}', 'en-US', now(), null),
          ($2, $3, $5, 'unlimited', 'open-space', null, 'active', $6::date,
            $6::date + 30, '{}', 'en-US', now(), true)`,
        [
          passId,
          unlimitedId,
          buyerAccount,
          holderAccount,
          invitedAccount,
          reservedDate,
        ]
      );
      await pool.query(
        `insert into payment_attempts
          (id, order_id, provider, provider_order_id, security_token, state,
           refund_state, refund_target_value, refunded_amount_value, refunded_at,
           amount_value, amount_exponent, currency)
         values
          ($1, $3, 'mock', 'winning-synthetic-order', 'synthetic-private-token', 'paid',
           'required', 50000, 10000, now(), 100000, 2, 'CZK'),
          ($2, $3, 'mock', 'replaced-synthetic-order', null, 'paid',
           'not_required', null, null, null, 70000, 2, 'CZK')`,
        [winner, extraCapture, passId]
      );
      await pool.query(
        `insert into legal_evidence_events
          (order_id, document_key, document_path, document_hash, hash_algorithm,
           accepted, accepted_at, locale, source, acknowledgements)
         values ($1, 'termsAndConditions', '/conditions', 'synthetic-hash',
           'sha256', true, now(), 'en-US', 'payment_submit', '{"entryPackEarlyStartRequested":true}')`,
        [passId]
      );
      const pack = await pool.query<{ id: string }>(
        `insert into workspace_reservations
          (checkout_attempt_key, author_account_id, dotypos_customer_id, reservation_state, payment_state,
           fulfillment_state, reservation_details, locale)
         values (uuid_generate_v7(), $1, $2, 'draft', 'not_started', 'not_started', '{}', 'en-US')
         returning id`,
        [holderAccount, holderId]
      );
      packReservationId = workspaceReservationIdSchema.make(pack.rows[0]!.id);
      await pool.query(
        `insert into pass_entry_claims (reservation_id, pass_id, date, status)
         values ($1, $2, '2024-06-20', 'consumed')`,
        [packReservationId, passId]
      );
      const day = await pool.query<{ id: string }>(
        `insert into workspace_reservations
          (checkout_attempt_key, dotypos_customer_id, dotypos_reservation_id, author_account_id,
           reservation_state, payment_state, fulfillment_state, reservation_details,
           locale, pass_id, service_date, pass_day_table_id, pass_day_hold_requested_at,
           pass_day_hold_generation, paid_at, fulfilled_at, reservation_confirmed_at)
         values (uuid_generate_v7(), $1, 'synthetic-current-reservation', $2, 'confirmed', 'paid',
           'fulfilled', '{}', 'en-US', $3, $4, 'synthetic-desk-2', now(),
           uuid_generate_v7(), now(), now(), now())
         returning id`,
        [holderId, buyerAccount, unlimitedId, reservedDate]
      );
      dayReservationId = workspaceReservationIdSchema.make(day.rows[0]!.id);
      await pool.query(
        `insert into unlimited_pass_day_moves
          (generation, reservation_id, customer_id, source_reservation_id,
           source_table_id, target_table_id, target_reservation_id, requested_at,
           checked_at, attached_at, settled_at)
         values (uuid_generate_v7(), $1, $2, 'synthetic-old-reservation',
           'synthetic-desk-1', 'synthetic-desk-2', 'synthetic-current-reservation',
           now(), now(), now(), now())`,
        [dayReservationId, holderId]
      );
    });
    afterAll(async () => {
      await database?.close();
    });

    test("filters calendar status, tier, product and paid gift source together", async () => {
      const page = await run(
        listAdminPasses({
          product: "entry-pack",
          tier: "open-space",
          status: "expired",
          source: "gift",
        })
      );
      expect(page.total).toBe(1);
      expect(page.passes).toMatchObject([
        { id: passId, entriesLeft: 4, status: "expired" },
      ]);
      expect(
        (await run(listAdminPasses({ status: "scheduled" }))).passes
      ).toMatchObject([
        { id: unlimitedId, claimed: false, holder: { email: invitationEmail } },
      ]);
      expect(
        (await run(listAdminPasses({ query: passId }))).passes
      ).toMatchObject([{ id: passId }]);
    });

    test("keeps eligible unlinked invitations searchable during a customer directory outage", async () => {
      const unavailableDirectory = Layer.mock(AdministrationCustomerDirectory, {
        findMany: () => Effect.succeed(new Map()),
        search: () => Effect.fail("synthetic directory failure"),
      });
      const response = await Effect.runPromise(
        listAdminPasses({ query: invitationEmail }).pipe(
          Effect.provide(unavailableDirectory),
          Effect.provide(database.layer)
        )
      );
      expect(response.searchIncomplete).toBe(true);
      expect(response.passes).toMatchObject([{ id: unlimitedId }]);
    });

    test("uses current account links and counts only the winning payment less confirmed refunds", async () => {
      const buyer = await run(readAdminCustomerPasses(buyerId));
      const holder = await run(readAdminCustomerPasses(holderId));
      expect(buyer.held).toEqual([]);
      expect(buyer.boughtForOthers).toMatchObject([{ id: passId }]);
      expect(buyer.spent).toEqual([
        { value: 90000, exponent: 2, currency: "CZK" },
      ]);
      expect(holder.held).toMatchObject([{ id: passId }]);
      expect(holder.spent).toEqual([]);
    });

    test("projects attempts, consent, claims and day moves without provider credentials", async () => {
      const pack = await run(readAdminPass(passId));
      expect(pack?.attempts).toHaveLength(2);
      expect(pack?.attempts.find(({ id }) => id === winner)).toMatchObject({
        refundState: "required",
        refundTargetValue: 50000,
        refundedAmountValue: 10000,
      });
      expect(JSON.stringify(pack)).not.toContain("synthetic-private-token");
      expect(pack?.consent).toMatchObject([
        {
          accepted: true,
          acknowledgements: { entryPackEarlyStartRequested: true },
        },
      ]);
      expect(pack?.claims).toMatchObject([
        { reservationId: packReservationId, status: "consumed" },
      ]);

      const unlimited = await run(readAdminPass(unlimitedId));
      expect(unlimited?.days).toMatchObject([
        {
          id: dayReservationId,
          date: reservedDate,
          tableId: "synthetic-desk-2",
        },
      ]);
      expect(unlimited?.moves).toMatchObject([
        {
          date: reservedDate,
          sourceTableId: "synthetic-desk-1",
          targetTableId: "synthetic-desk-2",
        },
      ]);
      const links = await run(
        readReservationPassLinks([packReservationId, dayReservationId])
      );
      expect(links.get(packReservationId)).toEqual({
        passId,
        product: "entry-pack",
      });
      expect(links.get(dayReservationId)).toEqual({
        passId: unlimitedId,
        product: "unlimited",
      });
    });
  }
);
