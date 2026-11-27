import type { DotyposTableId } from "@deskohub/dotypos";
import { Data, Effect, Layer } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { WorkspaceDatabaseAdvisoryLock } from "@/db/postgres-advisory-lock";
import { WorkspaceLockSections } from "@/db/workspace-locks";
import type { CustomerAccountId } from "@/features/account/customer-account";
import {
  WorkspaceAvailabilityService,
  WorkspaceTableUnavailableError,
} from "@/features/reservation/backend/workspace-availability.service";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import { getReservationDateBounds } from "@/features/reservation/reservation-interval";
import type { TableReservationDetails } from "@/features/reservation/table-reservation";
import { WorkspaceDotyposLayer } from "@/shared/backend/config/dotypos.config";
import { getPlainDatesBetween } from "@/shared/utils/temporal";
import { OpenSpaceTableMoves } from "./open-space-table-moves";
import type { TeamTablePlan } from "./team-table-plan";

class TeamTableCapacityChanged extends Data.TaggedError(
  "TeamTableCapacityChanged"
) {}

type AssignmentError =
  | Effect.Error<
      ReturnType<
        WorkspaceAvailabilityService["Service"]["getLiveTeamTablePlan"]
      >
    >
  | WorkspaceTableUnavailableError;

/** A capacity assignment that can only run inside the enclosing booking section. */
export type TeamTableBookingCapacity = {
  readonly assignTableId: Effect.Effect<DotyposTableId, AssignmentError>;
};

export const TeamTableBookingCapacityLive = Layer.mergeAll(
  WorkspaceAvailabilityService.Live,
  WorkspaceDatabaseAdvisoryLock.Default,
  OpenSpaceTableMoves.Default.pipe(
    Layer.provide(
      Layer.mergeAll(
        WorkspaceDatabase.Default,
        WorkspaceDatabaseAdvisoryLock.Default,
        WorkspaceReservationRepository.Live,
        WorkspaceDotyposLayer
      )
    )
  )
);

/**
 * Acquire source-order, author, and full Prague service-date keys together.
 * Account authority is rechecked by the caller under this author key. Only
 * the hold-creation step requests assignment, after checkout validation and
 * supersession have completed.
 */
export const withTeamTableBookingCapacity = <A, E, R>(
  {
    reservation,
    authorAccountId,
  }: {
    readonly reservation: TableReservationDetails;
    readonly authorAccountId: CustomerAccountId;
  },
  section: (capacity: TeamTableBookingCapacity) => Effect.Effect<A, E, R>
) =>
  Effect.gen(function* () {
    const availability = yield* WorkspaceAvailabilityService;
    const moves = yield* OpenSpaceTableMoves;
    const { first, last } = getReservationDateBounds(reservation);
    const unavailable = new WorkspaceTableUnavailableError({
      date: first.toString(),
      reservation: { kind: reservation.kind },
    });
    const discovered = yield* availability.getLiveTeamTablePlan(reservation);
    const dates = [
      ...getPlainDatesBetween(first, last),
      ...(discovered?.moves.map(({ serviceDate }) =>
        Temporal.PlainDate.from(serviceDate)
      ) ?? []),
    ];
    const lockedDates = new Set(dates.map(String));
    const lockedSources = new Set(
      discovered?.moves.map(({ reservationId }) => reservationId)
    );
    const needsMoreLocks = (plan: TeamTablePlan | undefined) =>
      plan?.moves.some(
        ({ reservationId, serviceDate }) =>
          !lockedSources.has(reservationId) || !lockedDates.has(serviceDate)
      ) ?? false;

    const assignTableId = Effect.gen(function* () {
      const fresh = yield* availability.getLiveTeamTablePlan(reservation);
      if (!fresh || needsMoreLocks(fresh)) return yield* unavailable;

      const moved = yield* moves
        .repackInCapacitySection({
          ...fresh,
          interval: reservation,
        })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Team Table repacking needs reconciliation", {
              cause,
            }).pipe(Effect.as(false))
          )
        );
      if (!moved) return yield* unavailable;

      const final = yield* availability.getLiveTeamTablePlan(
        reservation,
        fresh.tableId
      );
      if (final?.tableId !== fresh.tableId || final.moves.length !== 0)
        return yield* unavailable;
      return fresh.tableId;
    });

    const locked = Effect.gen(function* () {
      const fresh = yield* availability.getLiveTeamTablePlan(reservation);
      if (needsMoreLocks(fresh)) return yield* new TeamTableCapacityChanged();
      return yield* section({ assignTableId });
    });
    return yield* WorkspaceLockSections.reservationCapacity(dates, {
      authorAccountId,
      movedReservations: [...lockedSources],
    })(locked);
  }).pipe(
    Effect.retry({
      times: 3,
      while: (error) => error instanceof TeamTableCapacityChanged,
    }),
    Effect.mapError((error) =>
      error instanceof TeamTableCapacityChanged
        ? new WorkspaceTableUnavailableError({
            date: getReservationDateBounds(reservation).first.toString(),
            reservation: { kind: reservation.kind },
          })
        : error
    )
  );
