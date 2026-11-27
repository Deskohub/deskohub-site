import type { DotyposService, DotyposTableId } from "@deskohub/dotypos";
import { Effect, Option } from "effect";
import {
  excludeDotyposReservationsById,
  getOccupancyWindowDates,
  getTableBookingOccupancyById,
  toTableBookings,
} from "@/features/checkout/backend/reservation/workspace-table-occupancy";
import type { StoredWorkspaceReservationDetails } from "@/features/reservation/persistence-contracts";
import { currentInstant } from "@/shared/utils/temporal";
import type { BookedInterval } from "./booked-reservation";
import { hasSharedSeating } from "./customer-reservation-placement";
import type { WorkspaceReservationRepository } from "./workspace-reservation.repository";

type OpenSpacePlacementReads = {
  readonly dotypos: Pick<
    DotyposService["Service"],
    "listActiveReservationsOverlapping"
  >;
  readonly reservations: Pick<
    WorkspaceReservationRepository["Service"],
    | "selectExpiredHoldDotyposReservationIds"
    | "selectTeamTableDotyposReservationIds"
  >;
};

/** A Team Table is identified locally, but its current table comes from Dotypos. */
export const loadOpenSpaceExcludedTableIds = Effect.fn(
  "loadOpenSpaceExcludedTableIds"
)(function* (
  input: {
    readonly reservationDetails: StoredWorkspaceReservationDetails;
    readonly occupiedInterval: Option.Option<BookedInterval>;
  },
  { dotypos, reservations }: OpenSpacePlacementReads
) {
  if (
    !hasSharedSeating(input.reservationDetails) ||
    Option.isNone(input.occupiedInterval)
  ) {
    return undefined;
  }

  const { startsAt, endsAt } = input.occupiedInterval.value;
  const window = {
    startsAt: startsAt.epochMilliseconds,
    endsAt: endsAt.epochMilliseconds,
  };
  const observed = yield* dotypos.listActiveReservationsOverlapping(
    getOccupancyWindowDates(window)
  );
  const candidateIds = observed.flatMap(({ id, _tableId }) =>
    id && _tableId ? [id] : []
  );
  if (candidateIds.length === 0) return new Set<DotyposTableId>();

  const teamTableIds = new Set(
    yield* reservations.selectTeamTableDotyposReservationIds(candidateIds)
  );
  if (teamTableIds.size === 0) return new Set<DotyposTableId>();

  const expiredIds = yield* reservations.selectExpiredHoldDotyposReservationIds(
    {
      now: yield* currentInstant,
    }
  );
  const activeTeamTables = excludeDotyposReservationsById(
    observed.filter(({ id }) => id && teamTableIds.has(id)),
    expiredIds
  );

  return new Set(
    getTableBookingOccupancyById(
      toTableBookings(activeTeamTables),
      window
    ).keys()
  );
});
