import type { DotyposReservation } from "@deskohub/dotypos";
import {
  getOccupancyWindow,
  type TableBooking,
  toTableBookings,
  workspaceBookingSeatCount,
} from "@/features/checkout/backend/reservation/workspace-table-occupancy";
import type { ReservationRecord } from "@/features/reservation/backend/reservation-record";
import type { PendingPassDayCapacity } from "@/features/reservation/backend/workspace-reservation.repository";
import { getCoworkReservationInterval } from "@/features/reservation/cowork-reservation";
import { matchesUnlimitedPassDayHold } from "./unlimited-pass-dotypos-holds";

/** A creating pass day already holds capacity, even before Dotypos lists it. */
export const getBookingsWithPassDayIntents = (
  reservations: readonly (ReservationRecord &
    Pick<DotyposReservation, "_customerId" | "note">)[],
  intents: readonly PendingPassDayCapacity[]
): readonly TableBooking[] => {
  const providerBookings = toTableBookings(reservations);
  const localBookings = intents.flatMap(
    ({ passId, serviceDate, tableId, customerId, tier }) => {
      const interval = getCoworkReservationInterval(
        tier === "open-space" ? tier : "reserved-desk",
        serviceDate
      );
      const day = {
        serviceDate: Temporal.PlainDate.from(serviceDate),
        tableId,
        interval,
      };
      const visible = reservations.some(
        (record) =>
          (record.status === "NEW" || record.status === "CONFIRMED") &&
          matchesUnlimitedPassDayHold(record, { passId, customerId, day })
      );

      return visible
        ? []
        : [
            {
              ...getOccupancyWindow(interval),
              tableId,
              seats: workspaceBookingSeatCount,
            },
          ];
    }
  );

  return [...providerBookings, ...localBookings];
};
