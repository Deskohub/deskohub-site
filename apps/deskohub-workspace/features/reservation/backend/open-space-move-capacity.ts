import type {
  DotyposReservation,
  DotyposReservationId,
} from "@deskohub/dotypos";
import {
  type TableBooking,
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
  const activeRecords = records.filter(
    ({ status }) => status === "NEW" || status === "CONFIRMED"
  );
  const ids = new Map(activeRecords.map(({ id, _tableId }) => [id, _tableId]));
  const tablesByNoteLine = new Map<string, Set<CapacityRecord["_tableId"]>>();
  for (const record of activeRecords) {
    if (!record.note) continue;
    for (const line of record.note.split("\n")) {
      const tables = tablesByNoteLine.get(line);
      if (tables) tables.add(record._tableId);
      else tablesByNoteLine.set(line, new Set([record._tableId]));
    }
  }

  return claims.flatMap(({ generation, reservationId, ...booking }) =>
    (reservationId && ids.get(reservationId) === booking.tableId) ||
    (generation &&
      tablesByNoteLine
        .get(formatOpenSpaceMoveMarker(generation))
        ?.has(booking.tableId))
      ? []
      : [{ ...booking, seats: workspaceBookingSeatCount }]
  );
};
