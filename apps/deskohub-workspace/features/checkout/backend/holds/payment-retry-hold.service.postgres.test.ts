import "@/shared/polyfills/temporal";
import "@/shared/testing/workspace-test-env";

import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  type DotyposReservationId,
  DotyposReservationIdSchema,
  type DotyposReservationStatus,
  DotyposService,
  DotyposTableIdSchema,
} from "@deskohub/dotypos";
import { NexiOrderIdSchema } from "@deskohub/nexi";
import { eq, inArray } from "drizzle-orm";
import { Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { WorkspaceDatabaseAdvisoryLock } from "@/db/postgres-advisory-lock";
import {
  latePaymentRecoveries,
  openSpaceTableMoveBatches,
  openSpaceTableMoves,
  paymentAttempts,
  teamTableHoldClaims,
  workspaceReservations,
} from "@/db/schema";
import { makeCoworkInvoiceDocument } from "@/features/accounting/invoice.test-utils";
import type { PaymentAttemptId } from "@/features/checkout/checkout-identifiers";
import { getTableReservationQuote } from "@/features/checkout/reservation-quote-table";
import { getTableCheckoutDetails } from "@/features/checkout/schemas/checkout-details-table";
import { CoworkPassesReleaseGate } from "@/features/passes/backend/cowork-passes-release-gate";
import {
  WorkspaceAvailabilityService,
  WorkspaceTableUnavailableError,
} from "@/features/reservation/backend/workspace-availability.service";
import {
  type WorkspaceReservation,
  WorkspaceReservationRepository,
} from "@/features/reservation/backend/workspace-reservation.repository";
import { dotyposHoldFixture } from "@/features/reservation/backend/workspace-reservation.test-utils";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import { OpenSpaceTableMoves } from "@/features/team-table/backend/open-space-table-moves";
import { TeamTableHoldClaims } from "@/features/team-table/backend/team-table-hold-claims";
import { workspaceFixtures } from "@/shared/testing/workspace-fixtures.test-utils";
import {
  holdPostgresTransaction,
  waitForAdvisoryLockWaiter,
} from "@/shared/testing/workspace-postgres-lock-waiters.test-utils";
import {
  connectWorkspacePostgresTestDatabase,
  type WorkspacePostgresTestDatabase,
} from "@/shared/testing/workspace-postgres-test-database.test-utils";
import { instantStringSchema } from "@/shared/utils/temporal";
import { LatePaymentRecoveryRepository } from "../repositories/late-payment-recovery.repository";
import { PaymentAttemptRepository } from "../repositories/payment-attempt.repository";
import {
  type RecreatedReservation,
  rebuildAcceptedReservation,
} from "../reservation/order-dotypos-reservation";
import {
  getWorkspaceReservationInterval,
  WorkspaceTableAssignmentService,
} from "../reservation/workspace-table-assignment.service";
import { PaymentRetryHoldService } from "./payment-retry-hold.service";
import { ReservationHoldCleanupScheduleService } from "./reservation-hold-cleanup-queue.service";
import { UnpaidHoldRelease } from "./unpaid-hold-release.service";

const postgresDatabase = await connectWorkspacePostgresTestDatabase();

/** The accepted cowork reservation its last attempt priced, as a retry books it. */
const recreated = (() => {
  const rebuilt = rebuildAcceptedReservation(
    {
      reservationDetails: { kind: "cowork", entryTier: "basic", coffee: true },
    } as WorkspaceReservation,
    makeCoworkInvoiceDocument("en-US") as never,
    undefined
  );
  if (!rebuilt) throw new Error("The cowork reservation must rebuild.");
  return rebuilt;
})();

const createdDotyposId = DotyposReservationIdSchema.make("dotypos-created");

describe.skipIf(!postgresDatabase)(
  "PaymentRetryHoldService.secure on Postgres",
  () => {
    const postgres = postgresDatabase as WorkspacePostgresTestDatabase;
    const created: WorkspaceReservationId[] = [];

    afterEach(async () => {
      if (created.length === 0) return;
      await postgres.db
        .update(workspaceReservations)
        .set({ activePaymentAttemptId: null })
        .where(inArray(workspaceReservations.id, created))
        .pipe(Effect.runPromise);
      await postgres.db
        .delete(latePaymentRecoveries)
        .where(inArray(latePaymentRecoveries.workspaceReservationId, created))
        .pipe(Effect.runPromise);
      await postgres.db
        .delete(paymentAttempts)
        .where(inArray(paymentAttempts.workspaceReservationId, created))
        .pipe(Effect.runPromise);
      await postgres.db
        .delete(workspaceReservations)
        .where(inArray(workspaceReservations.id, created))
        .pipe(Effect.runPromise);
      created.length = 0;
    });

    /**
     * An order whose payment `paymentState` ended on its active attempt, with
     * the local reservation columns `overrides` names.
     */
    const retriedOrder = async (input: {
      readonly reservation: "held" | "cancelled" | "hold_expired";
      readonly overrides?: Partial<typeof workspaceReservations.$inferInsert>;
    }) => {
      const row = await workspaceFixtures(postgres.db)
        .reservation({ stage: { reservation: input.reservation } })
        .pipe(Effect.runPromise);
      created.push(row.id);
      const attemptId = `attempt-${crypto.randomUUID()}` as PaymentAttemptId;
      await postgres.db
        .insert(paymentAttempts)
        .values({
          id: attemptId,
          workspaceReservationId: row.id,
          provider: "nexi",
          providerOrderId: NexiOrderIdSchema.make(
            `order-${crypto.randomUUID()}`
          ),
          state: "failed",
          failureCode: "nexi_payment_failed",
          amountValue: 29_000,
          amountExponent: 2,
          currency: "CZK",
        })
        .pipe(Effect.runPromise);
      await postgres.db
        .update(workspaceReservations)
        .set({
          activePaymentAttemptId: attemptId,
          paymentState: "failed",
          failureCode: "nexi_payment_failed",
          ...input.overrides,
        })
        .where(eq(workspaceReservations.id, row.id))
        .pipe(Effect.runPromise);
      return { orderId: row.id, attemptId };
    };

    const rowOf = async (id: WorkspaceReservationId) => {
      const [row] = await postgres.db
        .select()
        .from(workspaceReservations)
        .where(eq(workspaceReservations.id, id))
        .pipe(Effect.runPromise);
      return row!;
    };

    const makeHarness = (
      options: {
        readonly status?: DotyposReservationStatus;
        readonly overlapping?: readonly unknown[];
        readonly unavailable?: boolean;
        readonly coworkPassesEnabled?: boolean;
        /** Runs when the retry creates the new Dotypos reservation. */
        readonly onCreate?: () => Promise<void>;
        readonly teamTable?: RecreatedReservation;
        readonly create?: DotyposService["Service"]["createReservation"];
      } = {}
    ) => {
      const spies = {
        getReservationStatus: mock((_id: DotyposReservationId) =>
          Effect.succeed<DotyposReservationStatus>(options.status ?? "NEW")
        ),
        cancelReservation: mock((_id: DotyposReservationId) => Effect.void),
        listActiveReservationsOverlapping: mock(() =>
          Effect.succeed((options.overlapping ?? []) as never)
        ),
        createReservation: mock(
          (
            input: Parameters<DotyposService["Service"]["createReservation"]>[0]
          ) =>
            options.create?.(input) ??
            Effect.promise(async () => {
              await options.onCreate?.();
              return { id: createdDotyposId } as never;
            })
        ),
        ensureAvailable: mock(() =>
          options.unavailable
            ? Effect.fail(new WorkspaceTableUnavailableError({} as never))
            : Effect.void
        ),
        enqueueCleanup: mock(() => Effect.void),
      };
      const reservations = WorkspaceReservationRepository.Default.pipe(
        Layer.provide(postgres.layer)
      );
      const dotypos = Layer.mock(DotyposService, {
        getReservationStatus: spies.getReservationStatus as never,
        cancelReservation: spies.cancelReservation as never,
        listActiveReservationsOverlapping:
          spies.listActiveReservationsOverlapping as never,
        createReservation: spies.createReservation as never,
      });
      const layer = PaymentRetryHoldService.Default.pipe(
        Layer.provide(
          Layer.mergeAll(
            reservations,
            CoworkPassesReleaseGate.fromDecision(
              options.coworkPassesEnabled ?? true
            ),
            LatePaymentRecoveryRepository.Default.pipe(
              Layer.provide(postgres.layer)
            ),
            PaymentAttemptRepository.Default.pipe(
              Layer.provide(postgres.layer)
            ),
            UnpaidHoldRelease.Default.pipe(
              Layer.provide(Layer.mergeAll(reservations, dotypos))
            ),
            dotypos,
            TeamTableHoldClaims.Default.pipe(
              Layer.provide(Layer.merge(postgres.layer, dotypos))
            ),
            Layer.mock(OpenSpaceTableMoves, {
              repackInCapacitySection: () => Effect.succeed(true),
            }),
            Layer.mock(WorkspaceAvailabilityService, {
              ensureAvailable: spies.ensureAvailable as never,
              getLiveTeamTablePlan: () =>
                Effect.succeed({
                  tableId: DotyposTableIdSchema.make("team-table"),
                  moves: [],
                }),
            }),
            Layer.mock(WorkspaceTableAssignmentService, {
              assignTableId: (() => Effect.succeed("table-id")) as never,
            }),
            Layer.mock(ReservationHoldCleanupScheduleService, {
              enqueueCleanup: spies.enqueueCleanup as never,
            }),
            WorkspaceDatabaseAdvisoryLock.makeLayer(postgres.databasePool)
          )
        )
      );
      const secureEffect = (order: {
        readonly orderId: WorkspaceReservationId;
        readonly attemptId: PaymentAttemptId;
      }) =>
        PaymentRetryHoldService.pipe(
          Effect.flatMap((service) =>
            service.secure({
              orderId: order.orderId,
              retriedAttemptId: order.attemptId,
              recreated: options.teamTable ?? recreated,
            })
          ),
          Effect.provide(layer)
        );
      return {
        spies,
        secureEffect,
        secure: (order: Parameters<typeof secureEffect>[0]) =>
          Effect.runPromise(secureEffect(order)),
      };
    };

    test("keeps an unfunded live hold with the pass gate closed and clears its retried attempt", async () => {
      const order = await retriedOrder({
        reservation: "held",
        overrides: {
          reservationHoldExpiresAt: Temporal.Now.instant().add({ minutes: 5 }),
        },
      });
      const before = await rowOf(order.orderId);
      const harness = makeHarness({ coworkPassesEnabled: false });

      const result = await harness.secure(order);

      expect(result.kind).toBe("kept");
      const after = await rowOf(order.orderId);
      expect(after.activePaymentAttemptId).toBeNull();
      expect(after.dotyposReservationId).toBe(before.dotyposReservationId);
      expect(after.reservationState).toBe("held");
      expect(harness.spies.cancelReservation).not.toHaveBeenCalled();
      expect(harness.spies.createReservation).not.toHaveBeenCalled();
    });

    test("defers replacing a hold while a table move still owns its old provider hold", async () => {
      const order = await retriedOrder({
        reservation: "held",
        overrides: {
          reservationHoldExpiresAt: Temporal.Now.instant().subtract({
            minutes: 5,
          }),
        },
      });
      const reservation = await rowOf(order.orderId);
      const time = Temporal.Now.instant();
      const serviceDate = "2030-01-03";
      const batchId = crypto.randomUUID();
      await postgres.pool.query(
        "insert into open_space_table_move_batches values ($1, $2, $2, $3)",
        [batchId, serviceDate, time.toString()]
      );
      await postgres.pool.query(
        `insert into open_space_table_moves (
          generation, batch_id, reservation_id, service_date, customer_id,
          source_reservation_id, source_table_id, source_note_line,
          target_reservation_id, target_table_id, status, starts_at, ends_at,
          attempted_at, attached_at, checked_at
        ) values (uuid_generate_v7(), $1, $2, $3, $4, 'synthetic-retiring-source',
          'synthetic-source-table', $5, $6, 'synthetic-target-table', 'NEW',
          '2030-01-02T23:00:00Z', '2030-01-03T16:00:00Z', $7, $7, $7)`,
        [
          batchId,
          order.orderId,
          serviceDate,
          reservation.dotyposCustomerId,
          `Platební objednávka: ${order.orderId}`,
          reservation.dotyposReservationId,
          time.toString(),
        ]
      );
      const harness = makeHarness();
      try {
        expect(await harness.secure(order)).toEqual({
          kind: "refused",
          reason: "release_in_progress",
        });
        expect(harness.spies.cancelReservation).not.toHaveBeenCalled();
        expect(
          harness.spies.listActiveReservationsOverlapping
        ).not.toHaveBeenCalled();
        expect(harness.spies.createReservation).not.toHaveBeenCalled();
        await postgres.db
          .update(openSpaceTableMoves)
          .set({ settledAt: time })
          .where(eq(openSpaceTableMoves.batchId, batchId))
          .pipe(Effect.runPromise);
        expect((await harness.secure(order)).kind).toBe("reacquired");
      } finally {
        await postgres.db
          .delete(openSpaceTableMoves)
          .where(eq(openSpaceTableMoves.batchId, batchId))
          .pipe(Effect.runPromise);
        await postgres.db
          .delete(openSpaceTableMoveBatches)
          .where(eq(openSpaceTableMoveBatches.id, batchId))
          .pipe(Effect.runPromise);
      }
    });

    test("releases an expired hold and books the same reservation again for the same order", async () => {
      const order = await retriedOrder({
        reservation: "held",
        overrides: {
          reservationHoldExpiresAt: Temporal.Now.instant().subtract({
            minutes: 1,
          }),
        },
      });
      const before = await rowOf(order.orderId);
      const harness = makeHarness();

      const result = await harness.secure(order);

      expect(result.kind).toBe("reacquired");
      expect(harness.spies.cancelReservation).toHaveBeenCalledWith(
        before.dotyposReservationId
      );
      expect(harness.spies.ensureAvailable).toHaveBeenCalledTimes(1);
      expect(harness.spies.createReservation).toHaveBeenCalledTimes(1);
      expect(harness.spies.createReservation.mock.calls[0]?.[0]).toMatchObject({
        status: "NEW",
      });
      const after = await rowOf(order.orderId);
      expect(after).toMatchObject({
        id: order.orderId,
        reservationState: "held",
        dotyposReservationId: createdDotyposId,
        activePaymentAttemptId: null,
        cancellationCause: null,
        reservationCancelledAt: null,
        paymentState: "failed",
      });
      expect(
        Temporal.Instant.compare(
          after.reservationHoldExpiresAt!,
          Temporal.Now.instant()
        )
      ).toBe(1);
      expect(harness.spies.enqueueCleanup).toHaveBeenCalledTimes(1);
    });

    test("stages a Team Table retry before posting and attaches the exact full-table hold", async () => {
      const order = await retriedOrder({
        reservation: "cancelled",
        overrides: {
          reservationDetails: { kind: "table", seats: 4, durationMinutes: 15 },
          cancellationCause: "hold_expired",
        },
      });
      const reservation = {
        kind: "table",
        seats: 4,
        startsAt: instantStringSchema.make("2030-01-03T09:00:00Z"),
        endsAt: instantStringSchema.make("2030-01-03T09:15:00Z"),
      } as const;
      const quote = await Effect.runPromise(
        getTableReservationQuote(reservation)
      );
      const harness = makeHarness({
        teamTable: {
          reservation,
          checkoutDetails: getTableCheckoutDetails({
            locale: "en-US",
            reservation,
            quote,
            legalEvidence: {},
          }),
        },
        create: (input) =>
          Effect.gen(function* () {
            const [staged] = yield* postgres.db
              .select()
              .from(teamTableHoldClaims)
              .where(eq(teamTableHoldClaims.reservationId, order.orderId));
            expect(staged).toMatchObject({
              purpose: "payment_retry",
              paymentAttemptId: order.attemptId,
              providerReservationIds: null,
              seats: 4,
            });
            expect(input).toMatchObject({
              tableId: "team-table",
              status: "NEW",
              seats: 4,
              singleAttempt: true,
            });
            expect(input.note).toContain(
              `Team Table hold: ${staged?.generation}`
            );
            return {
              ...dotyposHoldFixture(createdDotyposId),
              _tableId: input.tableId,
              _customerId: input.customerId,
              startDate: input.startDate.toISOString(),
              endDate: input.endDate.toISOString(),
              status: input.status,
              note: input.note,
              seats: String(input.seats),
            };
          }),
      });
      expect(await harness.secure(order)).toMatchObject({
        kind: "reacquired",
        reservation: { dotyposReservationId: createdDotyposId },
      });
      expect(harness.spies.createReservation).toHaveBeenCalledTimes(1);
    });

    test("books again a hold that hold cleanup already released", async () => {
      const order = await retriedOrder({
        reservation: "cancelled",
        overrides: { cancellationCause: "hold_expired" },
      });
      const harness = makeHarness();

      const result = await harness.secure(order);

      expect(result.kind).toBe("reacquired");
      expect(harness.spies.cancelReservation).not.toHaveBeenCalled();
      expect((await rowOf(order.orderId)).reservationState).toBe("held");
    });

    test("does not rebook a reservation that ends while waiting for capacity", async () => {
      const order = await retriedOrder({
        reservation: "cancelled",
        overrides: { cancellationCause: "hold_expired" },
      });
      const harness = makeHarness();
      const { reservation } = recreated;
      if (reservation.kind !== "cowork") throw new Error("Expected cowork");
      const interval = await Effect.runPromise(
        getWorkspaceReservationInterval(reservation)
      );
      const end = Temporal.Instant.from(interval.endsAt).epochMilliseconds;
      const key = ["reservation-capacity", reservation.date] as const;
      const holder = await holdPostgresTransaction(
        postgres.pool,
        "select pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        key
      );
      let committed = false;
      try {
        const outcome = await Effect.gen(function* () {
          yield* TestClock.setTime(end - 1);
          const waiting = yield* Effect.forkChild(harness.secureEffect(order));
          yield* Effect.promise(() =>
            waitForAdvisoryLockWaiter(postgres.pool, key)
          );
          yield* TestClock.adjust("2 millis");
          yield* Effect.promise(async () => {
            await holder.commit();
            committed = true;
          });
          return yield* Fiber.join(waiting);
        }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise);
        expect(outcome).toEqual({ kind: "refused", reason: "not_retryable" });
        expect(harness.spies.createReservation).not.toHaveBeenCalled();
      } finally {
        if (!committed) await holder.commit();
      }
    });

    test("keeps the same hold when a prepared retry is prepared again", async () => {
      const order = await retriedOrder({
        reservation: "held",
        overrides: {
          reservationHoldExpiresAt: Temporal.Now.instant().add({ minutes: 5 }),
        },
      });
      const before = await rowOf(order.orderId);
      const harness = makeHarness();

      await harness.secure(order);
      const again = await harness.secure(order);

      expect(again.kind).toBe("kept");
      expect((await rowOf(order.orderId)).dotyposReservationId).toBe(
        before.dotyposReservationId
      );
      expect(harness.spies.createReservation).not.toHaveBeenCalled();
    });

    test("books again a prepared retry whose hold then lapsed", async () => {
      const order = await retriedOrder({
        reservation: "cancelled",
        overrides: {
          activePaymentAttemptId: null,
          cancellationCause: "hold_expired",
        },
      });
      const harness = makeHarness();

      const result = await harness.secure(order);

      expect(result.kind).toBe("reacquired");
      expect((await rowOf(order.orderId)).reservationState).toBe("held");
    });

    test("never secures a retry of an attempt a newer one replaced", async () => {
      const order = await retriedOrder({
        reservation: "held",
        overrides: {
          activePaymentAttemptId: null,
          reservationHoldExpiresAt: Temporal.Now.instant().add({ minutes: 5 }),
        },
      });
      await postgres.db
        .insert(paymentAttempts)
        .values({
          id: `attempt-${crypto.randomUUID()}` as PaymentAttemptId,
          workspaceReservationId: order.orderId,
          provider: "nexi",
          providerOrderId: NexiOrderIdSchema.make(
            `order-${crypto.randomUUID()}`
          ),
          state: "failed",
          failureCode: "nexi_payment_failed",
          amountValue: 29_000,
          amountExponent: 2,
          currency: "CZK",
          createdAt: Temporal.Now.instant().add({ minutes: 1 }),
        })
        .pipe(Effect.runPromise);
      const harness = makeHarness();

      const result = await harness.secure(order);

      expect(result).toEqual({ kind: "refused", reason: "not_retryable" });
      expect(harness.spies.getReservationStatus).not.toHaveBeenCalled();
    });

    test.each([
      ["an operator's cancellation", "operator" as const],
      ["a superseded checkout", "checkout_superseded" as const],
      ["a cancellation of unknown origin", null],
    ])("never books again %s", async (_name, cancellationCause) => {
      const order = await retriedOrder({
        reservation: "cancelled",
        overrides: { cancellationCause },
      });
      const harness = makeHarness();

      const result = await harness.secure(order);

      expect(result).toEqual({ kind: "refused", reason: "not_retryable" });
      expect(harness.spies.createReservation).not.toHaveBeenCalled();
      expect((await rowOf(order.orderId)).reservationState).toBe("cancelled");
    });

    test("refuses while a late payment of the order is being recovered", async () => {
      const order = await retriedOrder({
        reservation: "cancelled",
        overrides: { cancellationCause: "hold_expired" },
      });
      await postgres.db
        .insert(latePaymentRecoveries)
        .values({
          paymentAttemptId: order.attemptId,
          workspaceReservationId: order.orderId,
          state: "pending",
          originalDotyposReservationId: DotyposReservationIdSchema.make(
            `dotypos-original-${crypto.randomUUID()}`
          ),
          verifiedPaidAt: Temporal.Now.instant(),
        })
        .pipe(Effect.runPromise);
      const harness = makeHarness();

      const result = await harness.secure(order);

      expect(result).toEqual({ kind: "refused", reason: "not_retryable" });
      expect(harness.spies.createReservation).not.toHaveBeenCalled();
    });

    test("says the spot is gone and leaves the order cancelled when no table is free", async () => {
      const order = await retriedOrder({
        reservation: "cancelled",
        overrides: { cancellationCause: "hold_expired" },
      });
      const harness = makeHarness({ unavailable: true });

      const result = await harness.secure(order);

      expect(result).toEqual({ kind: "spot_unavailable" });
      expect(harness.spies.createReservation).not.toHaveBeenCalled();
      expect((await rowOf(order.orderId)).reservationState).toBe("cancelled");
    });

    test("leaves an expired hold Dotypos no longer holds as NEW to an operator", async () => {
      const order = await retriedOrder({
        reservation: "held",
        overrides: {
          reservationHoldExpiresAt: Temporal.Now.instant().subtract({
            minutes: 1,
          }),
        },
      });
      const harness = makeHarness({ status: "CONFIRMED" });

      const result = await harness.secure(order);

      expect(result).toEqual({ kind: "refused", reason: "release_refused" });
      expect(harness.spies.cancelReservation).not.toHaveBeenCalled();
      expect(harness.spies.createReservation).not.toHaveBeenCalled();
    });

    test("takes over the one NEW reservation an interrupted earlier retry created", async () => {
      const order = await retriedOrder({
        reservation: "cancelled",
        overrides: { cancellationCause: "payment_retry" },
      });
      const orphan = DotyposReservationIdSchema.make("dotypos-orphan");
      const harness = makeHarness({
        overlapping: [
          {
            id: orphan,
            status: "NEW",
            note: `Platební objednávka: ${order.orderId}`,
          },
        ],
      });

      const result = await harness.secure(order);

      expect(result.kind).toBe("reacquired");
      expect(harness.spies.createReservation).not.toHaveBeenCalled();
      expect((await rowOf(order.orderId)).dotyposReservationId).toBe(orphan);
    });

    const withReleasedEntryClaim = async (
      orderId: WorkspaceReservationId,
      status: "active" | "cancelled",
      run: () => Promise<void>
    ) => {
      const row = await rowOf(orderId);
      const packId = crypto.randomUUID();
      await postgres.pool.query(
        `insert into orders
          (id, kind, dotypos_customer_id, payment_state, fulfillment_state, paid_at)
          values ($1, 'pass-purchase', 'fixture-buyer', 'paid', 'not_started', now())`,
        [packId]
      );
      try {
        await postgres.pool.query(
          `insert into pass_purchases
            (id, buyer_account_id, holder_account_id, product, tier, entry_count, status, valid_from, valid_until, quote, locale, created_at)
            values ($1, $2, $2, 'entry-pack', 'open-space', 5, $3, '2099-06-01', '2099-07-01', '{}', 'en-US', now())`,
          [packId, row.authorAccountId, status]
        );
        await postgres.pool.query(
          `insert into pass_entry_claims (reservation_id, pass_id, date, status)
            values ($1, $2, '2099-06-12', 'released')`,
          [orderId, packId]
        );
        await run();
      } finally {
        await postgres.pool.query(
          "delete from pass_entry_claims where pass_id = $1",
          [packId]
        );
        await postgres.pool.query("delete from pass_purchases where id = $1", [
          packId,
        ]);
        await postgres.pool.query("delete from orders where id = $1", [packId]);
      }
    };

    test("leaves a released Entry claim and its attempt alone when the gate has closed", async () => {
      const order = await retriedOrder({
        reservation: "held",
        overrides: {
          reservationHoldExpiresAt: Temporal.Now.instant().add({ minutes: 5 }),
        },
      });
      await withReleasedEntryClaim(order.orderId, "active", async () => {
        const closed = makeHarness({ coworkPassesEnabled: false });
        expect(await closed.secure(order)).toEqual({
          kind: "spot_unavailable",
        });
        const claim = () =>
          postgres.pool.query(
            "select status from pass_entry_claims where reservation_id = $1",
            [order.orderId]
          );
        expect((await claim()).rows).toEqual([{ status: "released" }]);
        expect((await rowOf(order.orderId)).activePaymentAttemptId).toBe(
          order.attemptId
        );
        expect(closed.spies.getReservationStatus).not.toHaveBeenCalled();
        expect(closed.spies.cancelReservation).not.toHaveBeenCalled();
        expect(closed.spies.createReservation).not.toHaveBeenCalled();

        const open = makeHarness();
        expect(await open.secure(order)).toMatchObject({ kind: "kept" });
        expect((await claim()).rows).toEqual([{ status: "reserved" }]);
      });
    });

    test("cancels an interrupted retry's NEW hold when the Entry pack can no longer attach", async () => {
      const order = await retriedOrder({
        reservation: "cancelled",
        overrides: { cancellationCause: "payment_retry" },
      });
      await withReleasedEntryClaim(order.orderId, "cancelled", async () => {
        const orphan = DotyposReservationIdSchema.make(
          "entry-pack-retry-orphan"
        );
        const harness = makeHarness({
          overlapping: [
            {
              id: orphan,
              status: "NEW",
              note: `Platební objednávka: ${order.orderId}`,
            },
          ],
        });
        expect(await harness.secure(order)).toEqual({
          kind: "spot_unavailable",
        });
        expect(harness.spies.cancelReservation).toHaveBeenCalledWith(orphan);
        expect(harness.spies.createReservation).not.toHaveBeenCalled();
        expect((await rowOf(order.orderId)).reservationState).toBe("cancelled");
      });
    });

    test("cancels the reservation it created when the order changed before it could be attached", async () => {
      const order = await retriedOrder({
        reservation: "cancelled",
        overrides: { cancellationCause: "hold_expired" },
      });
      const harness = makeHarness({
        onCreate: () =>
          postgres.db
            .update(workspaceReservations)
            .set({ cancellationCause: "operator" })
            .where(eq(workspaceReservations.id, order.orderId))
            .pipe(Effect.runPromise)
            .then(() => {}),
      });

      const result = await harness.secure(order);

      expect(result).toEqual({ kind: "refused", reason: "changed" });
      expect(harness.spies.cancelReservation).toHaveBeenCalledWith(
        createdDotyposId
      );
      expect((await rowOf(order.orderId)).reservationState).toBe("cancelled");
    });

    test("books one Dotypos reservation when the same retry is secured twice at once", async () => {
      const order = await retriedOrder({
        reservation: "cancelled",
        overrides: { cancellationCause: "hold_expired" },
      });
      // Booking takes long enough for the second call to arrive meanwhile.
      const harness = makeHarness({ onCreate: () => Bun.sleep(300) });

      const results = await Promise.all([
        harness.secure(order),
        harness.secure(order),
      ]);

      // The second waits for the first's lock section, then keeps its hold.
      expect(results.map((result) => result.kind).toSorted()).toEqual([
        "kept",
        "reacquired",
      ]);
      expect(harness.spies.createReservation).toHaveBeenCalledTimes(1);
    });
  }
);
