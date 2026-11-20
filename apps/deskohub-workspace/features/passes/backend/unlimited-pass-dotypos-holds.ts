import {
  type DotyposCustomerId,
  type DotyposReservation,
  DotyposService,
} from "@deskohub/dotypos";
import { Effect, Option } from "effect";
import { workspaceBookingSeatCount } from "@/features/checkout/backend/reservation/workspace-table-occupancy";
import type { OrderId } from "@/features/order";
import { decodeBookedReservation } from "@/features/reservation/backend/booked-reservation";
import { workspaceSiteConstants } from "@/shared/utils/site-constants";
import {
  getPlainDatesBetween,
  temporalInstantToDate,
} from "@/shared/utils/temporal";
import { unlimitedPassDays } from "../pass-offer";
import type { UnlimitedPassDay } from "./unlimited-pass-capacity";

const passDayMarkerPrefix = (passId: OrderId) =>
  `Deskohub Unlimited ${passId}/`;

const passDayMarker = (passId: OrderId, serviceDate: Temporal.PlainDate) =>
  `${passDayMarkerPrefix(passId)}${serviceDate}`;

type PassDayHold = {
  readonly passId: OrderId;
  readonly customerId: DotyposCustomerId;
  readonly day: UnlimitedPassDay;
};

/** Creates one NEW hold. The caller journals intent before sending it. */
export const createUnlimitedPassDayHold = Effect.fn(
  "createUnlimitedPassDayHold"
)(function* ({
  passId,
  customerId,
  day,
  coffee,
}: PassDayHold & {
  readonly coffee?: boolean;
}) {
  const dotypos = yield* DotyposService;
  return yield* dotypos.createReservation({
    customerId,
    tableId: day.tableId,
    startDate: temporalInstantToDate(
      Temporal.Instant.from(day.interval.startsAt)
    ),
    endDate: temporalInstantToDate(Temporal.Instant.from(day.interval.endsAt)),
    seats: workspaceBookingSeatCount,
    status: "NEW",
    note: [
      passDayMarker(passId, day.serviceDate),
      `Káva: ${coffee ? "ano" : "ne"}`,
    ].join("\n"),
  });
});

/** Lists the pass's marked records, including cancelled holds for settlement. */
export const listUnlimitedPassDayHolds = Effect.fn("listUnlimitedPassDayHolds")(
  function* (input: {
    readonly passId: OrderId;
    readonly customerId: DotyposCustomerId;
    readonly startDate: Temporal.PlainDate;
  }) {
    const dotypos = yield* DotyposService;
    const timeZone = workspaceSiteConstants.location.timeZone;
    const endsBefore = input.startDate.add({ days: unlimitedPassDays });
    const records = yield* dotypos.listReservations({
      customerId: input.customerId,
      startsAtOrAfter: input.startDate
        .toZonedDateTime(timeZone)
        .toInstant()
        .toString(),
      startsBefore: endsBefore.toZonedDateTime(timeZone).toInstant().toString(),
    });
    const markers = new Set(
      getPlainDatesBetween(
        input.startDate,
        endsBefore.subtract({ days: 1 })
      ).map((date) => passDayMarker(input.passId, date))
    );
    return records.filter(
      (record) =>
        record._customerId === input.customerId &&
        record.note?.split("\n").some((line) => markers.has(line))
    );
  }
);

export const hasUnlimitedPassDayMarker = (
  record: Pick<DotyposReservation, "note">,
  passId: OrderId,
  serviceDate: Temporal.PlainDate
) =>
  record.note?.split("\n").includes(passDayMarker(passId, serviceDate)) ??
  false;

/** Matches the booking facts required when settling a marked attempt. */
export const matchesUnlimitedPassDayHold = (
  record: Pick<
    DotyposReservation,
    "_customerId" | "_tableId" | "note" | "startDate" | "endDate" | "seats"
  >,
  { passId, customerId, day }: PassDayHold
) => {
  if (
    !hasUnlimitedPassDayMarker(record, passId, day.serviceDate) ||
    record._customerId !== customerId ||
    record._tableId !== day.tableId
  ) {
    return false;
  }
  const booked = decodeBookedReservation(record);
  return (
    Option.exists(
      booked.seats,
      (seats) => seats === workspaceBookingSeatCount
    ) &&
    Option.exists(
      booked.interval,
      ({ startsAt, endsAt }) =>
        startsAt.equals(day.interval.startsAt) &&
        endsAt.equals(day.interval.endsAt)
    )
  );
};
