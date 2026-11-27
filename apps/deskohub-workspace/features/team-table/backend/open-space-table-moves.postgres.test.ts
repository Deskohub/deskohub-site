import "@/shared/testing/workspace-test-env";

import { afterAll, describe, expect, test } from "bun:test";
import {
  DotyposCustomerIdSchema,
  DotyposService,
  DotyposTableSchema,
  DotyposUncertain,
} from "@deskohub/dotypos";
import { makeInMemoryDotypos } from "@deskohub/dotypos/testing";
import { Effect, Layer, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { WorkspaceDatabaseAdvisoryLock } from "@/db/postgres-advisory-lock";
import { orderIdSchema } from "@/features/order";
import { formatPassDayMarker } from "@/features/passes/pass-day-marker";
import { getUnobservedOpenSpaceMoveBookings } from "@/features/reservation/backend/open-space-move-capacity";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import { getCoworkReservationInterval } from "@/features/reservation/cowork-reservation";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import { reservationIntervalSchema } from "@/features/reservation/reservation-interval";
import {
  holdPostgresTransaction,
  waitForAdvisoryLockWaiter,
} from "@/shared/testing/workspace-postgres-lock-waiters.test-utils";
import { createWorkspacePostgresSuiteDatabase } from "@/shared/testing/workspace-postgres-test-database.test-utils";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import { OpenSpaceTableMoves } from "./open-space-table-moves";

const database = await createWorkspacePostgresSuiteDatabase("open_space_moves");
afterAll(() => database?.close());

const date = plainDateStringSchema.make("2027-03-28");
const nextDate = plainDateStringSchema.make("2027-03-29");
const now = Date.parse("2027-03-27T08:00:00Z");
const provider = makeInMemoryDotypos();
let nextTableId = 1;
const interval = Schema.decodeUnknownSync(reservationIntervalSchema)({
  startsAt: "2027-03-28T14:00:00Z",
  endsAt: "2027-03-28T14:30:00Z",
});
const makeTable = (id: string, seats: string, ...tags: string[]) =>
  Schema.decodeUnknownSync(DotyposTableSchema)({
    id,
    seats,
    tags: ["cowork:open-space", ...tags],
    _cloudId: "1",
    display: true,
    enabled: true,
    name: id,
  });

describe.skipIf(!database)("Open Space table moves", () => {
  if (!database) return;

  const fixture = () => {
    const sourceTable = makeTable(
      String(nextTableId++),
      "4",
      "reservation:table"
    );
    const targetTable = makeTable(String(nextTableId++), "3");
    const { pool } = database;
    const customerId = DotyposCustomerIdSchema.make("3");

    const source = async (
      status: "NEW" | "CONFIRMED",
      serviceDate = date,
      tier = "open-space"
    ) => {
      const reservationId = workspaceReservationIdSchema.make(
        crypto.randomUUID()
      );
      const author = crypto.randomUUID();
      const { startsAt, endsAt } = getCoworkReservationInterval(
        "open-space",
        serviceDate
      );
      const original = await Effect.runPromise(
        provider.service.createReservation({
          customerId,
          tableId: sourceTable.id,
          startDate: new Date(startsAt),
          endDate: new Date(endsAt),
          seats: 1,
          status,
          note: `Platební objednávka: ${reservationId}\nKáva: ne`,
        })
      );
      const confirmed = status === "CONFIRMED";
      await pool.query("insert into customer_accounts (id) values ($1)", [
        author,
      ]);
      await pool.query(
        `insert into workspace_reservations
          (id, checkout_attempt_key, dotypos_customer_id, dotypos_reservation_id,
           author_account_id, reservation_details, locale, reservation_state,
           payment_state, fulfillment_state, reservation_hold_expires_at,
           paid_at, fulfilled_at, reservation_confirmed_at)
         values ($1, uuid_generate_v7(), $2, $3, $4, $5, 'en-US',
           case when $6 then 'confirmed' else 'held' end,
           case when $6 then 'paid' else 'pending' end,
           case when $6 then 'fulfilled' else 'not_started' end, $7,
           case when $6 then now() end, case when $6 then now() end,
           case when $6 then now() end)`,
        [
          reservationId,
          customerId,
          original.id,
          author,
          JSON.stringify({ kind: "cowork", entryTier: tier, coffee: false }),
          confirmed,
          "2027-03-27T09:00:00Z",
        ]
      );
      return {
        reservationId,
        serviceDate,
        status,
        sourceReservationId: original.id,
        targetTableId: targetTable.id,
      };
    };

    const run = <A, E>(
      effect: Effect.Effect<
        A,
        E,
        OpenSpaceTableMoves | WorkspaceReservationRepository
      >,
      overrides: Partial<typeof DotyposService.Service> = {}
    ) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* TestClock.setTime(now);
          return yield* effect;
        }).pipe(
          Effect.provide(OpenSpaceTableMoves.Default),
          Effect.provide(
            Layer.mergeAll(
              database.layer,
              WorkspaceDatabaseAdvisoryLock.makeLayer(database.databasePool),
              WorkspaceReservationRepository.Default.pipe(
                Layer.provide(database.layer)
              ),
              Layer.succeed(DotyposService, {
                ...provider.service,
                getTables: () => Effect.succeed([sourceTable, targetTable]),
                ...overrides,
              }),
              TestClock.layer()
            )
          )
        )
      );
    const read = (
      id: Parameters<typeof provider.service.getReservationWithoutCustomer>[0]
    ) => Effect.runPromise(provider.service.getReservationWithoutCustomer(id));
    const local = async (id: string) =>
      (
        await pool.query("select * from workspace_reservations where id = $1", [
          id,
        ])
      ).rows[0];
    const order = async (id: string) =>
      (await pool.query("select * from orders where id = $1", [id])).rows[0];
    const grant = async (id: string) =>
      (
        await pool.query(
          "select * from reservation_access_grants where workspace_reservation_id = $1",
          [id]
        )
      ).rows[0];
    const plan = (
      moves: readonly Awaited<ReturnType<typeof source>>[],
      requestedInterval = interval
    ) => ({ tableId: sourceTable.id, interval: requestedInterval, moves });
    return {
      provider,
      source,
      run,
      read,
      local,
      order,
      grant,
      plan,
      sourceTable,
      targetTable,
    };
  };

  test("moves paid Open Space to another table without replacing the order or access grant", async () => {
    const f = fixture();
    const move = await f.source("CONFIRMED");
    await database.pool.query(
      `insert into reservation_access_grants
       (workspace_reservation_id, device_id, state, reservation_starts_at,
        access_starts_at, access_ends_at, issued_at)
       values ($1, 'synthetic-device', 'expired', now(), now(), now() + interval '1 hour', now())`,
      [move.reservationId]
    );
    const before = await f.local(move.reservationId);
    const order = await f.order(move.reservationId);
    const grant = await f.grant(move.reservationId);
    const result = await f.run(
      Effect.flatMap(OpenSpaceTableMoves, (service) =>
        service.repack(f.plan([move]), Effect.succeed("assigned"))
      )
    );
    expect(result).toEqual(Option.some("assigned"));
    const after = await f.local(move.reservationId);
    expect(after.dotypos_reservation_id).not.toBe(move.sourceReservationId);
    expect(after).toEqual({
      ...before,
      dotypos_reservation_id: after.dotypos_reservation_id,
      updated_at: after.updated_at,
    });
    expect(await f.order(move.reservationId)).toEqual(order);
    expect(await f.grant(move.reservationId)).toEqual(grant);
    expect(await f.read(after.dotypos_reservation_id)).toMatchObject({
      _tableId: f.targetTable.id,
      status: "CONFIRMED",
      startDate: (await f.read(move.sourceReservationId)).startDate,
      endDate: (await f.read(move.sourceReservationId)).endDate,
    });
    expect(await f.read(move.sourceReservationId)).toMatchObject({
      status: "CANCELLED",
    });
    expect(
      await f.run(
        Effect.flatMap(WorkspaceReservationRepository, (repository) =>
          repository.claimRequestedCancellation({
            id: move.reservationId,
            expectedDotyposReservationId: move.sourceReservationId,
            cause: "operator",
            staleCancellingBefore: Temporal.Instant.fromEpochMilliseconds(now),
          })
        )
      )
    ).toBeNull();
    expect(await f.local(move.reservationId)).toMatchObject({
      dotypos_reservation_id: after.dotypos_reservation_id,
      reservation_state: "confirmed",
    });
  });

  test("retires a staged replacement after a cross-midnight batch fails without another POST", async () => {
    const f = fixture();
    const first = await f.source("CONFIRMED");
    const second = await f.source("NEW", nextDate);
    const crossMidnight = Schema.decodeUnknownSync(reservationIntervalSchema)({
      startsAt: "2027-03-28T14:00:00Z",
      endsAt: "2027-03-28T22:15:00Z",
    });
    const created: Awaited<ReturnType<typeof f.read>>[] = [];
    const createReservation: typeof f.provider.service.createReservation = (
      input
    ) =>
      f.provider.service.createReservation(input).pipe(
        Effect.flatMap((record) => {
          created.push(record);
          return created.length === 2
            ? Effect.fail(
                new DotyposUncertain({
                  operation: "createReservation",
                  request: "reservation.create",
                  reason: "timeout",
                  message: "Lost create response",
                })
              )
            : Effect.succeed(record);
        })
      );
    const result = await f.run(
      Effect.flatMap(OpenSpaceTableMoves, (service) =>
        service
          .repack(
            f.plan([first, second], crossMidnight),
            Effect.die("stale assignment")
          )
          .pipe(Effect.result)
      ),
      { createReservation }
    );
    expect(result._tag).toBe("Failure");
    expect(await f.read(first.sourceReservationId)).toMatchObject({
      status: "CANCELLED",
    });
    expect((await f.local(second.reservationId)).dotypos_reservation_id).toBe(
      second.sourceReservationId
    );
    const claims = await f.run(
      Effect.flatMap(WorkspaceReservationRepository, (repository) =>
        repository.selectOpenSpaceMoveCapacity({
          first: Temporal.PlainDate.from(nextDate),
          last: Temporal.PlainDate.from(nextDate),
        })
      )
    );
    expect(getUnobservedOpenSpaceMoveBookings(claims, [])).toMatchObject([
      { tableId: f.targetTable.id, seats: 1 },
    ]);
    await f.run(
      Effect.flatMap(OpenSpaceTableMoves, (service) => service.reconcile(10)),
      { createReservation }
    );
    const replacement = (await f.local(second.reservationId))
      .dotypos_reservation_id;
    expect(replacement).toBe(second.sourceReservationId);
    expect(created).toHaveLength(2);
    if (!created[1]) throw new Error("Expected a staged replacement");
    expect(await f.read(created[1].id)).toMatchObject({
      status: "CANCELLED",
      _tableId: f.targetTable.id,
    });
    expect(await f.read(second.sourceReservationId)).toMatchObject({
      status: "NEW",
    });
  });

  test("moves an unexpired NEW hold and leaves it payable", async () => {
    const f = fixture();
    const move = await f.source("NEW");
    const result = await f.run(
      Effect.flatMap(OpenSpaceTableMoves, (service) =>
        service.repack(f.plan([move]), Effect.succeed("assigned"))
      )
    );
    expect(result).toEqual(Option.some("assigned"));
    const row = await f.local(move.reservationId);
    expect(row).toMatchObject({
      reservation_state: "held",
      payment_state: "pending",
    });
    expect(row.dotypos_reservation_id).not.toBe(move.sourceReservationId);
    expect(await f.read(row.dotypos_reservation_id)).toMatchObject({
      status: "NEW",
      _tableId: f.targetTable.id,
    });
    expect(await f.read(move.sourceReservationId)).toMatchObject({
      status: "CANCELLED",
    });
  });

  test("keeps a consumed Entry Pack visit attached to its pass", async () => {
    const f = fixture();
    const move = await f.source("CONFIRMED");
    const passId = orderIdSchema.make(crypto.randomUUID());
    const original = await f.local(move.reservationId);
    const { pool } = database;
    await pool.query(
      `insert into orders (id, kind, dotypos_customer_id, payment_state,
        fulfillment_state, paid_at, fulfilled_at)
       values ($1, 'pass-purchase', $2, 'paid', 'fulfilled', now(), now())`,
      [passId, original.dotypos_customer_id]
    );
    await pool.query(
      `insert into pass_purchases (id, buyer_account_id, holder_account_id, product,
        tier, entry_count, status, valid_from, valid_until, quote, locale, created_at)
       values ($1, $2, $2, 'entry-pack', 'open-space', 5, 'active',
        $3::date, $3::date + 30, '{}', 'en-US', now())`,
      [passId, original.author_account_id, date]
    );
    await pool.query(
      `insert into pass_entry_claims (reservation_id, pass_id, date, status)
       values ($1, $2, $3, 'consumed')`,
      [move.reservationId, passId, date]
    );
    const result = await f.run(
      Effect.flatMap(OpenSpaceTableMoves, (service) =>
        service.repack(f.plan([move]), Effect.succeed("assigned"))
      )
    );
    expect(result).toEqual(Option.some("assigned"));
    const updated = await f.local(move.reservationId);
    expect(await f.read(updated.dotypos_reservation_id)).toMatchObject({
      status: "CONFIRMED",
      _tableId: f.targetTable.id,
    });
    const claim = await pool.query(
      "select pass_id, status from pass_entry_claims where reservation_id = $1",
      [move.reservationId]
    );
    expect(claim.rows).toEqual([{ pass_id: passId, status: "consumed" }]);
  });

  test("keeps Reserved Desk on its original table", async () => {
    const f = fixture();
    const move = await f.source("CONFIRMED", date, "reserved-desk");
    const result = await f.run(
      Effect.flatMap(OpenSpaceTableMoves, (service) =>
        service.repack(f.plan([move]), Effect.die("stale assignment"))
      )
    );
    expect(result).toEqual(Option.none());
    expect(await f.read(move.sourceReservationId)).toMatchObject({
      status: "CONFIRMED",
    });
  });

  test("keeps the original NEW hold when payment arrives before attachment", async () => {
    const f = fixture();
    const move = await f.source("NEW");
    let staged: Awaited<ReturnType<typeof f.read>> | undefined;
    const createReservation: typeof f.provider.service.createReservation = (
      input
    ) =>
      f.provider.service.createReservation(input).pipe(
        Effect.tap((replacement) =>
          Effect.promise(async () => {
            staged = replacement;
            await database.pool.query(
              "update workspace_reservations set payment_state = 'paid', paid_at = now() where id = $1",
              [move.reservationId]
            );
          })
        )
      );
    const result = await f.run(
      Effect.flatMap(OpenSpaceTableMoves, (service) =>
        service.repack(f.plan([move]), Effect.die("stale assignment"))
      ),
      { createReservation }
    );
    expect(result).toEqual(Option.none());
    expect(await f.local(move.reservationId)).toMatchObject({
      dotypos_reservation_id: move.sourceReservationId,
      payment_state: "paid",
    });
    expect(await f.read(move.sourceReservationId)).toMatchObject({
      status: "NEW",
    });
    if (!staged) throw new Error("Expected a staged replacement");
    expect(await f.read(staged.id)).toMatchObject({ status: "CANCELLED" });
  });

  test("keeps a source when the locked checkout plan no longer matches", async () => {
    const f = fixture();
    const move = await f.source("CONFIRMED");
    const result = await f.run(
      Effect.flatMap(OpenSpaceTableMoves, (service) =>
        service.repack(
          f.plan([move]),
          Effect.die("stale assignment"),
          Effect.succeed(false)
        )
      ),
      { createReservation: () => Effect.die("stale move") }
    );
    expect(result).toEqual(Option.none());
    expect(await f.read(move.sourceReservationId)).toMatchObject({
      status: "CONFIRMED",
    });
  });

  test("holds both Prague capacity dates before moving any reservation", async () => {
    const f = fixture();
    const move = await f.source("CONFIRMED");
    const crossMidnight = Schema.decodeUnknownSync(reservationIntervalSchema)({
      startsAt: "2027-03-28T14:00:00Z",
      endsAt: "2027-03-28T22:15:00Z",
    });
    const key = ["reservation-capacity", nextDate] as const;
    const holder = await holdPostgresTransaction(
      database.pool,
      "select pg_advisory_xact_lock(hashtext($1), hashtext($2))",
      key
    );
    const assignment = f.run(
      Effect.flatMap(OpenSpaceTableMoves, (service) =>
        service.repack(
          f.plan([move], crossMidnight),
          Effect.succeed("assigned")
        )
      )
    );
    try {
      await waitForAdvisoryLockWaiter(database.pool, key);
      expect((await f.local(move.reservationId)).dotypos_reservation_id).toBe(
        move.sourceReservationId
      );
    } finally {
      await holder.commit();
    }
    expect(await assignment).toEqual(Option.some("assigned"));
  });

  test("moves an Unlimited Pass day with its pass identity and history", async () => {
    const f = fixture();
    const passId = orderIdSchema.make(crypto.randomUUID());
    const reservationId = workspaceReservationIdSchema.make(
      crypto.randomUUID()
    );
    const accountId = crypto.randomUUID();
    const customerId = DotyposCustomerIdSchema.make("3");
    const generation = crypto.randomUUID();
    const serviceDate = Temporal.PlainDate.from(date);
    const fullDay = getCoworkReservationInterval("open-space", date);
    const source = await Effect.runPromise(
      f.provider.service.createReservation({
        customerId,
        tableId: f.sourceTable.id,
        startDate: new Date(fullDay.startsAt),
        endDate: new Date(fullDay.endsAt),
        status: "CONFIRMED",
        seats: 1,
        note: formatPassDayMarker(passId, serviceDate, generation),
      })
    );
    const { pool } = database;
    await pool.query("insert into customer_accounts (id) values ($1)", [
      accountId,
    ]);
    await pool.query(
      `insert into orders (id, kind, dotypos_customer_id, payment_state,
        fulfillment_state, paid_at, fulfilled_at)
       values ($1, 'pass-purchase', $2, 'paid', 'fulfilled', now(), now())`,
      [passId, customerId]
    );
    await pool.query(
      `insert into pass_purchases (id, buyer_account_id, holder_account_id, product,
        tier, status, valid_from, valid_until, quote, locale, created_at, unlimited_coffee)
       values ($1, $2, $2, 'unlimited', 'open-space', 'active',
        $3::date, $3::date + 30, '{}', 'en-US', now(), false)`,
      [passId, accountId, date]
    );
    await pool.query(
      `insert into workspace_reservations (id, checkout_attempt_key, dotypos_customer_id,
        dotypos_reservation_id, author_account_id, reservation_state, payment_state,
        fulfillment_state, reservation_details, locale, pass_id, service_date,
        pass_day_table_id, pass_day_hold_requested_at, pass_day_hold_generation,
        paid_at, fulfilled_at, reservation_confirmed_at)
       values ($1, uuid_generate_v7(), $2, $3, $4, 'confirmed', 'paid', 'fulfilled',
        '{}', 'en-US', $5, $6, $7, now(), $8, now(), now(), now())`,
      [
        reservationId,
        customerId,
        source.id,
        accountId,
        passId,
        date,
        f.sourceTable.id,
        generation,
      ]
    );
    const order = await f.order(passId);
    const result = await f.run(
      Effect.flatMap(OpenSpaceTableMoves, (service) =>
        service.repack(
          f.plan([
            {
              reservationId,
              serviceDate: date,
              status: "CONFIRMED",
              sourceReservationId: source.id,
              targetTableId: f.targetTable.id,
            },
          ]),
          Effect.succeed("assigned")
        )
      )
    );
    expect(result).toEqual(Option.some("assigned"));
    const after = await f.local(reservationId);
    expect(after.pass_day_table_id).toBe(f.targetTable.id);
    expect(after.pass_day_hold_generation).not.toBe(generation);
    expect(await f.order(passId)).toEqual(order);
    expect(await f.read(source.id)).toMatchObject({ status: "CANCELLED" });
    const target = await f.read(after.dotypos_reservation_id);
    expect(target.note).toContain(
      formatPassDayMarker(passId, serviceDate, after.pass_day_hold_generation)
    );
    expect(target.note).not.toContain(generation);
  });
});
