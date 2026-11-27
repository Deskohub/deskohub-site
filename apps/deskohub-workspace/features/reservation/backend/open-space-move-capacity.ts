import type {
  DotyposReservation,
  DotyposReservationId,
} from "@deskohub/dotypos";
import {
  type TableBooking,
  toTableBookings,
  workspaceBookingSeatCount,
} from "@/features/checkout/backend/reservation/workspace-table-occupancy";
import { formatOpenSpaceMoveMarker } from "./open-space-move-marker";
import type { ReservationRecord } from "./reservation-record";

export type OpenSpaceMoveCapacityClaim = Omit<TableBooking, "seats"> & {
  readonly reservationId: DotyposReservationId | null;
  readonly generation: string | null;
};

type CapacityRecord = ReservationRecord & Pick<DotyposReservation, "note">;

/** A staged move holds one seat even before Dotypos's inventory lists it. */
export const getUnobservedOpenSpaceMoveBookings = (
  claims: readonly OpenSpaceMoveCapacityClaim[],
  records: readonly CapacityRecord[]
): readonly TableBooking[] => {
  if (claims.length === 0) return [];
  const byId = new Map(
    claims.flatMap((claim) =>
      claim.reservationId ? [[claim.reservationId, claim] as const] : []
    )
  );
  const byMarker = new Map(
    claims.flatMap((claim) =>
      claim.generation
        ? [[formatOpenSpaceMoveMarker(claim.generation), claim] as const]
        : []
    )
  );
  const observed = new Set<OpenSpaceMoveCapacityClaim>();
  for (const record of records) {
    const matchById = byId.get(record.id);
    const matchByMarker =
      record.note?.split("\n").flatMap((line) => byMarker.get(line) ?? []) ??
      [];
    const matches = matchById ? [matchById, ...matchByMarker] : matchByMarker;
    if (matches.length === 0) continue;
    const [booking] = toTableBookings([record]);
    if (!booking) continue;
    for (const claim of matches) {
      if (
        booking.tableId === claim.tableId &&
        booking.startsAt === claim.startsAt &&
        booking.endsAt === claim.endsAt
      )
        observed.add(claim);
    }
  }

  return claims
    .filter((claim) => !observed.has(claim))
    .map(({ generation: _generation, reservationId: _id, ...booking }) => ({
      ...booking,
      seats: workspaceBookingSeatCount,
    }));
};
