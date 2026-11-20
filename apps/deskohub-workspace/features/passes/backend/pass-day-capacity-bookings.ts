import type { DotyposReservation } from "@deskohub/dotypos";
import {
  getOccupancyWindow,
  type TableBooking,
  toTableBookings,
  workspaceBookingSeatCount,
} from "@/features/checkout/backend/reservation/workspace-table-occupancy";
import type { OrderId } from "@/features/order";
import type { ReservationRecord } from "@/features/reservation/backend/reservation-record";
import type { PendingPassDayCapacity } from "@/features/reservation/backend/workspace-reservation.repository";
import { getCoworkReservationInterval } from "@/features/reservation/cowork-reservation";
import { matchesUnlimitedPassDayHold } from "./unlimited-pass-dotypos-holds";

/** A creating pass day already holds capacity, even before Dotypos lists it. */
export const getBookingsWithPassDayIntents = (
  reservations: readonly (ReservationRecord &
    Pick<DotyposReservation, "_customerId" | "note">)[],
  intents: readonly PendingPassDayCapacity[],
  supersedeOrderId?: OrderId
): readonly TableBooking[] => {
  const excluded = supersedeOrderId
    ? intents.filter((intent) => intent.passId === supersedeOrderId)
    : [];
  const activeReservations = excluded.length
    ? reservations.filter(
        (record) =>
          !excluded.some(({ passId, serviceDate, tableId, customerId, tier }) =>
            matchesUnlimitedPassDayHold(record, {
              passId,
              customerId,
              day: {
                serviceDate: Temporal.PlainDate.from(serviceDate),
                tableId,
                interval: getCoworkReservationInterval(
                  tier === "open-space" ? tier : "reserved-desk",
                  serviceDate
                ),
              },
            })
          )
      )
    : reservations;
  const providerBookings = toTableBookings(activeReservations);
  const localBookings = intents.flatMap(
    ({ passId, serviceDate, tableId, customerId, tier }) => {
      if (passId === supersedeOrderId) return [];
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
