import type { DotyposReservation } from "@deskohub/dotypos";

/**
 * The Dotypos reservation fields Workspace reads to show, place, and check a
 * reservation: no customer link and no free-text note, so it can be shared
 * across requests.
 */
export type ReservationRecord = Pick<
  DotyposReservation,
  "id" | "status" | "_tableId" | "startDate" | "endDate" | "seats"
> & {
  readonly unlimitedPassDay?: true;
};

const unlimitedPassDayMarker =
  /^Deskohub Unlimited [0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\/\d{4}-\d{2}-\d{2}$/m;

/** Drops customer links and free-text notes before sharing a reservation. */
export const toReservationRecord = ({
  id,
  status,
  _tableId,
  startDate,
  endDate,
  seats,
  note,
}: ReservationRecord &
  Pick<DotyposReservation, "note">): ReservationRecord => ({
  id,
  status,
  ...(_tableId !== undefined && { _tableId }),
  startDate,
  endDate,
  seats,
  ...(note && unlimitedPassDayMarker.test(note) && { unlimitedPassDay: true }),
});
