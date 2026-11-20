import type { DotyposTableId } from "@deskohub/dotypos";
import { Data, Effect } from "effect";
import { WorkspaceLockSections } from "@/db/workspace-locks";
import {
  decodeTableCandidates,
  excludeDotyposReservationsById,
  getOccupancyWindow,
  getTableBookingOccupancyById,
  getWorkspaceTableCandidatesByPredicate,
  hasCandidateCapacity,
  isWorkspaceCoworkTableCandidate,
  type WorkspaceCoworkTableCandidateQuery,
  type WorkspaceTableCandidate,
} from "@/features/checkout/backend/reservation";
import { selectWorkspaceTableFromCandidates } from "@/features/checkout/backend/reservation/workspace-table-selection";
import type { WorkspaceProductMonitorOption } from "@/features/checkout/product-catalog";
import {
  getFullyOccupiedCalendarDates,
  makeProviderInventory,
} from "@/features/reservation/backend/availability-inventory";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import {
  getCoworkReservationInterval,
  isCoworkOpenSpaceDayCutoffReached,
} from "@/features/reservation/cowork-reservation";
import { getCurrentWorkspaceDate } from "@/features/reservation/reservation-date";
import type { ReservationInterval } from "@/features/reservation/reservation-interval";
import { getPlainDatesBetween } from "@/shared/utils/temporal";
import { unlimitedPassDays } from "../pass-offer";
import { getBookingsWithPassDayIntents } from "./pass-day-capacity-bookings";

export type UnlimitedPassCapacitySelection =
  | { readonly tier: "open-space" | "reserved-desk" }
  | {
      readonly tier: "reserved-desk-workstation";
      readonly monitorOption: WorkspaceProductMonitorOption;
    };

export type UnlimitedPassDay = {
  readonly serviceDate: Temporal.PlainDate;
  readonly tableId: DotyposTableId;
  readonly interval: ReservationInterval;
};

export type UnlimitedPassCapacityPlan = {
  readonly days: readonly UnlimitedPassDay[];
  readonly pinnedDesk: Pick<
    WorkspaceTableCandidate["table"],
    "id" | "name"
  > | null;
};

export class UnlimitedPassCapacityUnavailable extends Data.TaggedError(
  "UnlimitedPassCapacityUnavailable"
)<{
  readonly blockingDates: readonly Temporal.PlainDate[];
  readonly reason: "day-unavailable" | "no-common-desk";
}> {}

export class InvalidUnlimitedStartRange extends Data.TaggedError(
  "InvalidUnlimitedStartRange"
)<{
  readonly message: string;
}> {}

export const unlimitedStartRangeMaxDays = 62;

const getCapacityQuery = (
  selection: UnlimitedPassCapacitySelection
): WorkspaceCoworkTableCandidateQuery =>
  selection.tier === "reserved-desk-workstation"
    ? { entryTier: "reserved-desk", monitorOption: selection.monitorOption }
    : { entryTier: selection.tier };

const loadUnlimitedCapacity = Effect.fn("loadUnlimitedCapacity")(function* (
  selection: UnlimitedPassCapacitySelection,
  dates: readonly Temporal.PlainDate[],
  now: Temporal.Instant
) {
  const inventory = yield* makeProviderInventory;
  const workspaceReservations = yield* WorkspaceReservationRepository;
  const query = getCapacityQuery(selection);
  const intervals = dates.map((date) =>
    getCoworkReservationInterval(query.entryTier, date.toString())
  );
  const first = dates[0]!;
  const last = dates.at(-1)!;
  // Read intents before the provider list so a concurrent attach cannot
  // disappear between a stale provider list and a later local-state read.
  const intents = yield* workspaceReservations.selectPendingPassDayCapacity({
    first,
    last,
  });

  const { tables, reservations, limitations, expiredIds } = yield* Effect.all(
    {
      tables: inventory.tables,
      reservations: inventory.listActiveReservationsOverlapping({
        startDate: new Date(getOccupancyWindow(intervals[0]!).startsAt),
        endDate: new Date(getOccupancyWindow(intervals.at(-1)!).endsAt),
      }),
      limitations: inventory.listLimitations({
        from: first.toString(),
        to: last.toString(),
      }),
      expiredIds: workspaceReservations.selectExpiredHoldDotyposReservationIds({
        now,
      }),
    },
    { concurrency: "unbounded" }
  );

  const candidates = yield* Effect.fromResult(
    decodeTableCandidates(
      getWorkspaceTableCandidatesByPredicate(tables, (tags) =>
        isWorkspaceCoworkTableCandidate(tags, query)
      )
    )
  );
  const closedDates = getFullyOccupiedCalendarDates(limitations);
  const bookings = getBookingsWithPassDayIntents(
    excludeDotyposReservationsById(reservations, expiredIds),
    intents
  );
  const today = getCurrentWorkspaceDate(now);
  const days = dates.map((serviceDate, index) => {
    const interval = intervals[index]!;
    const occupancy = getTableBookingOccupancyById(
      bookings,
      getOccupancyWindow(interval)
    );
    const date = serviceDate.toString();
    const closed =
      Temporal.PlainDate.compare(serviceDate, today) < 0 ||
      closedDates.has(date) ||
      isCoworkOpenSpaceDayCutoffReached({
        entryTier: query.entryTier,
        date,
        now,
      });
    const freeTables = closed
      ? []
      : candidates
          .filter((candidate) => hasCandidateCapacity([candidate], occupancy))
          .map(({ table }) => table);

    return { serviceDate, interval, occupancy, freeTables };
  });

  return { tables, days };
});

type CapacityInventory = Effect.Success<
  ReturnType<typeof loadUnlimitedCapacity>
>;
type CapacityDay = CapacityInventory["days"][number];

const getCommonDesks = (days: readonly CapacityDay[]) =>
  days[0]!.freeTables.filter(({ id }) =>
    days.every(({ freeTables }) => freeTables.some((table) => table.id === id))
  );

/** Loads a calendar-sized range of possible starts with one inventory read. */
export const getBookableUnlimitedStarts = Effect.fn(
  "getBookableUnlimitedStarts"
)(function* (input: {
  readonly selection: UnlimitedPassCapacitySelection;
  readonly startsOn: Temporal.PlainDate;
  readonly endsBefore: Temporal.PlainDate;
}) {
  const dayCount = input.startsOn.until(input.endsBefore).days;
  if (dayCount < 0 || dayCount > unlimitedStartRangeMaxDays) {
    return yield* new InvalidUnlimitedStartRange({
      message: `Unlimited start range must cover at most ${unlimitedStartRangeMaxDays} days in chronological order.`,
    });
  }
  if (dayCount === 0) return [];

  const dates = getPlainDatesBetween(
    input.startsOn,
    input.endsBefore.add({ days: unlimitedPassDays - 2 })
  );
  const { days } = yield* loadUnlimitedCapacity(
    input.selection,
    dates,
    Temporal.Now.instant()
  );

  return dates.slice(0, dayCount).filter((_, index) => {
    const window = days.slice(index, index + unlimitedPassDays);
    return input.selection.tier === "open-space"
      ? window.every(({ freeTables }) => freeTables.length > 0)
      : getCommonDesks(window).length > 0;
  });
});

const getPassDates = (startDate: Temporal.PlainDate) =>
  getPlainDatesBetween(
    startDate,
    startDate.add({ days: unlimitedPassDays - 1 })
  );

const allocateUnlimitedPass = Effect.fn("allocateUnlimitedPass")(function* (
  selection: UnlimitedPassCapacitySelection,
  dates: readonly Temporal.PlainDate[]
) {
  const { tables, days } = yield* loadUnlimitedCapacity(
    selection,
    dates,
    Temporal.Now.instant()
  );
  const blocked = days.filter(({ freeTables }) => freeTables.length === 0);
  if (blocked.length > 0) {
    return yield* new UnlimitedPassCapacityUnavailable({
      blockingDates: blocked.map(({ serviceDate }) => serviceDate),
      reason: "day-unavailable",
    });
  }

  if (selection.tier === "open-space") {
    const planDays = yield* Effect.forEach(
      days,
      Effect.fnUntraced(function* ({
        serviceDate,
        interval,
        freeTables,
        occupancy,
      }) {
        const table = yield* selectWorkspaceTableFromCandidates(
          freeTables,
          tables,
          occupancy
        );
        // Capacity was checked above, using the same seats and occupancy.
        return { serviceDate, interval, tableId: table!.id };
      })
    );
    return {
      days: planDays,
      pinnedDesk: null,
    } satisfies UnlimitedPassCapacityPlan;
  }

  const commonDesks = getCommonDesks(days);
  if (commonDesks.length === 0) {
    return yield* new UnlimitedPassCapacityUnavailable({
      blockingDates: dates,
      reason: "no-common-desk",
    });
  }

  // Rank the remaining desks with the same selection logic as a day booking.
  const desk = (yield* selectWorkspaceTableFromCandidates(
    commonDesks,
    tables,
    days[0]!.occupancy
  ))!;
  return {
    pinnedDesk: { id: desk.id, name: desk.name },
    days: days.map(({ serviceDate, interval }) => ({
      serviceDate,
      interval,
      tableId: desk.id,
    })),
  } satisfies UnlimitedPassCapacityPlan;
});

/** The callback commits the plan's durable day intents before releasing the locks. */
export const withUnlimitedPassCapacity = <A, E, R>(
  input: {
    readonly selection: UnlimitedPassCapacitySelection;
    readonly startDate: Temporal.PlainDate;
  },
  save: (plan: UnlimitedPassCapacityPlan) => Effect.Effect<A, E, R>
) => {
  const dates = getPassDates(input.startDate);
  return allocateUnlimitedPass(input.selection, dates).pipe(
    Effect.flatMap(save),
    WorkspaceLockSections.reservationCapacity(dates)
  );
};
