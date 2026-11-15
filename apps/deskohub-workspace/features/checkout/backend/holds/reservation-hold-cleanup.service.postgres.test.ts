import "@/shared/polyfills/temporal";
import "@/shared/testing/workspace-test-env";

import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  type DotyposReservationId,
  DotyposReservationIdSchema,
  DotyposService,
} from "@deskohub/dotypos";
import { eq, inArray } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { toStoredInstant } from "@/db/instant";
import { workspaceReservations } from "@/db/schema";
import { recordCheckoutAnalytics } from "@/features/checkout/backend/analytics/checkout-analytics.service.mock";
import { paymentAttemptIdSchema } from "@/features/checkout/checkout-identifiers";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import { workspaceFixtures } from "@/shared/testing/workspace-fixtures.test-utils";
import {
  connectWorkspacePostgresTestDatabase,
  type WorkspacePostgresTestDatabase,
} from "@/shared/testing/workspace-postgres-test-database.test-utils";
import { ProviderPaymentFinalizationService } from "../payment/provider-payment-finalization.service";
import { PaymentLifecycleRepository } from "../repositories/payment-lifecycle.repository";
import { processReservationHoldCleanupScheduleMessage } from "./reservation-hold-cleanup-queue.service";
import { ReservationHoldCleanupService } from "./reservation-hold-cleanup.service";
import { UnpaidHoldRelease } from "./unpaid-hold-release.service";

const postgresDatabase = await connectWorkspacePostgresTestDatabase();

describe.skipIf(!postgresDatabase)(
  "Hold cleanup of a hold a payment retry replaced, on Postgres",
  () => {
    const postgres = postgresDatabase as WorkspacePostgresTestDatabase;
    const created: WorkspaceReservationId[] = [];

    afterEach(async () => {
      if (created.length === 0) return;
      await postgres.db
        .delete(workspaceReservations)
        .where(inArray(workspaceReservations.id, created))
        .pipe(Effect.runPromise);
      created.length = 0;
    });

    /** A held, unpaid reservation whose first hold expired a minute ago. */
    const expiredHold = async () => {
      const row = await workspaceFixtures(postgres.db)
        .reservation({
          stage: { reservation: "held" },
          overrides: {
            reservationHoldExpiresAt: Temporal.Now.instant().subtract({
              minutes: 1,
            }),
          },
        })
        .pipe(Effect.runPromise);
      created.push(row.id);
      return row;
    };

    const rowOf = async (id: WorkspaceReservationId) => {
      const [row] = await postgres.db
        .select()
        .from(workspaceReservations)
        .where(eq(workspaceReservations.id, id))
        .pipe(Effect.runPromise);
      return row!;
    };

    const writeRow = (
      id: WorkspaceReservationId,
      values: Partial<typeof workspaceReservations.$inferInsert>
    ) =>
      postgres.db
        .update(workspaceReservations)
        .set(values)
        .where(eq(workspaceReservations.id, id))
        .pipe(Effect.orDie, Effect.asVoid);

    /**
     * What a payment retry will do: the first hold cancelled, then the order
     * held again with a second Dotypos hold and expiry and a pending payment
     * of the retry, so a cleanup that went on would finalize that payment.
     * Written directly, since the retry doesn't exist yet.
     */
    const reacquire = (id: WorkspaceReservationId) =>
      writeRow(id, {
        reservationState: "cancelled",
        reservationCancelledAt: Temporal.Now.instant(),
        cancellationCause: "hold_expired",
      }).pipe(
        Effect.andThen(
          writeRow(id, {
            reservationState: "held",
            reservationCancelledAt: null,
            cancellationCause: null,
            dotyposReservationId: DotyposReservationIdSchema.make(
              `retry-second-hold-${id}`
            ),
            reservationHoldExpiresAt: Temporal.Now.instant().add({
              minutes: 10,
            }),
            paymentState: "pending",
            activePaymentAttemptId: paymentAttemptIdSchema.make(
              `retry-attempt-${id}`
            ),
          })
        )
      );

    /**
     * The real repository, with a payment retry taking the second hold right
     * after the cleanup's first read of the order.
     */
    const racingReservations = (input: {
      readonly read: "findById" | "selectExpiredHolds";
      readonly orderId: WorkspaceReservationId;
      readonly race: boolean;
    }) =>
      Layer.effect(
        WorkspaceReservationRepository,
        Effect.gen(function* () {
          const real = yield* WorkspaceReservationRepository;
          let raced = !input.race;
          const raceOnce = Effect.suspend(() => {
            if (raced) return Effect.void;
            raced = true;
            return reacquire(input.orderId);
          });
          return WorkspaceReservationRepository.of({
            ...real,
            findById: (id) =>
              real
                .findById(id)
                .pipe(
                  Effect.tap(() =>
                    input.read === "findById" ? raceOnce : Effect.void
                  )
                ),
            // The sweep selected this order, still with its first hold.
            selectExpiredHolds: () =>
              real.findById(input.orderId).pipe(
                Effect.map((row) => (row ? [row] : [])),
                Effect.tap(() => raceOnce)
              ),
          });
        })
      ).pipe(
        Layer.provide(WorkspaceReservationRepository.Default),
        Layer.provide(postgres.layer)
      );

    const makeDotypos = () => ({
      getReservationStatus: mock((_id: DotyposReservationId) =>
        Effect.succeed("NEW" as const)
      ),
      cancelReservation: mock((_id: DotyposReservationId) => Effect.void),
    });

    const services = (
      reservations: ReturnType<typeof racingReservations>,
      dotypos: ReturnType<typeof makeDotypos>
    ) => {
      const finalizePendingProviderPayment = mock(() =>
        Effect.die("A cleanup of the first hold finalized the retry's payment.")
      );
      const layer = ReservationHoldCleanupService.Default.pipe(
        Layer.provide(UnpaidHoldRelease.Default),
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProviderPaymentFinalizationService, {
              finalizePendingProviderPayment,
            }),
            Layer.mock(PaymentLifecycleRepository, {
              markTerminal: mock(() => Effect.die("not used")),
            }),
            recordCheckoutAnalytics().layer,
            Layer.mock(DotyposService, {
              getReservationStatus: dotypos.getReservationStatus as never,
              cancelReservation: dotypos.cancelReservation as never,
            })
          )
        ),
        Layer.provideMerge(reservations)
      );
      return { layer, finalizePendingProviderPayment };
    };

    const queueMessage = (order: {
      readonly id: WorkspaceReservationId;
      readonly reservationHoldExpiresAt: Temporal.Instant | null;
    }) => ({
      schemaVersion: 1 as const,
      orderId: order.id,
      reservationHoldExpiresAtIso: toStoredInstant(
        order.reservationHoldExpiresAt!
      ).toString(),
    });

    describe("a queued cleanup", () => {
      test("cancels the expired hold it was queued for", async () => {
        const order = await expiredHold();
        const dotypos = makeDotypos();
        const { layer } = services(
          racingReservations({
            read: "findById",
            orderId: order.id,
            race: false,
          }),
          dotypos
        );

        const outcome = await processReservationHoldCleanupScheduleMessage(
          queueMessage(order)
        ).pipe(Effect.provide(layer), Effect.runPromise);

        expect(outcome).toBe("cancelled");
        expect(dotypos.cancelReservation).toHaveBeenCalledWith(
          order.dotyposReservationId
        );
      });

      test("that read the first hold can't claim, cancel, or settle the second", async () => {
        const order = await expiredHold();
        const dotypos = makeDotypos();
        const { layer, finalizePendingProviderPayment } = services(
          racingReservations({
            read: "findById",
            orderId: order.id,
            race: true,
          }),
          dotypos
        );

        const outcome = await processReservationHoldCleanupScheduleMessage(
          queueMessage(order)
        ).pipe(Effect.provide(layer), Effect.runPromise);

        const after = await rowOf(order.id);
        expect(outcome).toBe("skipped");
        expect(after).toMatchObject({
          reservationState: "held",
          paymentState: "pending",
        });
        expect(after.dotyposReservationId).not.toBe(order.dotyposReservationId);
        expect(finalizePendingProviderPayment).not.toHaveBeenCalled();
        expect(dotypos.getReservationStatus).not.toHaveBeenCalled();
        expect(dotypos.cancelReservation).not.toHaveBeenCalled();
      });
    });

    describe("the daily sweep", () => {
      test("that selected the first hold can't claim, cancel, or settle the second", async () => {
        const order = await expiredHold();
        const dotypos = makeDotypos();
        const { layer, finalizePendingProviderPayment } = services(
          racingReservations({
            read: "selectExpiredHolds",
            orderId: order.id,
            race: true,
          }),
          dotypos
        );

        const summary = await ReservationHoldCleanupService.pipe(
          Effect.flatMap((cleanup) =>
            cleanup.sweepExpiredHolds({ now: Temporal.Now.instant(), limit: 1 })
          ),
          Effect.provide(layer),
          Effect.runPromise
        );

        const after = await rowOf(order.id);
        expect(summary).toEqual({ cancelled: 0, skipped: 1, failed: 0 });
        expect(after.reservationState).toBe("held");
        expect(after.dotyposReservationId).not.toBe(order.dotyposReservationId);
        expect(finalizePendingProviderPayment).not.toHaveBeenCalled();
        expect(dotypos.getReservationStatus).not.toHaveBeenCalled();
        expect(dotypos.cancelReservation).not.toHaveBeenCalled();
      });
    });
  }
);
