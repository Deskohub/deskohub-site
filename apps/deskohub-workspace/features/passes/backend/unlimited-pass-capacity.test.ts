import "@/shared/polyfills/temporal";
import "@/shared/testing/workspace-test-env";

import { expect, test } from "bun:test";
import {
  DotyposCustomerIdSchema,
  type DotyposReservation,
  DotyposReservationSchema,
  DotyposService,
  type DotyposTable,
  DotyposTableSchema,
} from "@deskohub/dotypos";
import { Effect, Layer, Schema } from "effect";
import { makeRecordingAdvisoryLock } from "@/db/postgres-advisory-lock.test-utils";
import { WorkspaceTableAssignmentService } from "@/features/checkout/backend/reservation/workspace-table-assignment.service";
import { workspaceProductMonitorOptionTableTags } from "@/features/checkout/product-catalog";
import { orderIdSchema } from "@/features/order";
import { GoogleCalendarWorkspaceLimitationsService } from "@/features/reservation/backend/google-calendar-workspace-limitations.service";
import {
  type PendingPassDayCapacity,
  WorkspaceReservationRepository,
} from "@/features/reservation/backend/workspace-reservation.repository";
import { getCoworkReservationInterval } from "@/features/reservation/cowork-reservation";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import {
  getBookableUnlimitedStarts,
  withUnlimitedPassCapacity,
} from "./unlimited-pass-capacity";
import {
  createUnlimitedPassDayHold,
  hasUnlimitedPassDayMarker,
  listUnlimitedPassDayHolds,
  matchesUnlimitedPassDayHold,
} from "./unlimited-pass-dotypos-holds";

const startDate = Temporal.PlainDate.from("2099-03-29");
const nextDate = startDate.add({ days: 1 });
const customerId = DotyposCustomerIdSchema.make("1");
const passId = orderIdSchema.make("d4989c37-1c90-4ebc-8cf9-4a6d17612ad6");

const makeTable = (id: string, tags: readonly string[], seats = "1") =>
  Schema.decodeSync(DotyposTableSchema)({
    _cloudId: "1",
    id,
    display: true,
    enabled: true,
    name: `Table ${id}`,
    seats,
    tags: [...tags],
  });

const openTable = makeTable("2", ["cowork:open-space"], "2");
const otherOpenTable = makeTable("3", ["cowork:open-space"]);
const firstDesk = makeTable("4", ["cowork:reserved-desk"]);
const otherDesk = makeTable("5", ["cowork:reserved-desk"]);

const providerBooking = (
  id: string,
  table: DotyposTable,
  date: Temporal.PlainDate
) => {
  const { startsAt, endsAt } = getCoworkReservationInterval(
    "reserved-desk",
    date.toString()
  );
  return Schema.decodeSync(DotyposReservationSchema)({
    _branchId: "1",
    _cloudId: "1",
    _tableId: table.id,
    _customerId: customerId,
    id,
    startDate: startsAt,
    endDate: endsAt,
    seats: table.seats,
    status: "CONFIRMED",
  });
};

const capacityLayer = (input: {
  readonly tables: readonly DotyposTable[];
  readonly providerBookings?: readonly DotyposReservation[];
  readonly intents?: readonly PendingPassDayCapacity[];
}) => {
  const lock = makeRecordingAdvisoryLock();
  const services = Layer.mergeAll(
    Layer.succeed(DotyposService, {
      getTables: () => Effect.succeed(input.tables),
      listActiveReservationsOverlapping: () =>
        Effect.succeed(input.providerBookings ?? []),
    } as DotyposService["Service"]),
    Layer.succeed(WorkspaceReservationRepository, {
      selectExpiredHoldDotyposReservationIds: () => Effect.succeed([]),
      selectPendingPassDayCapacity: () => Effect.succeed(input.intents ?? []),
    } as WorkspaceReservationRepository["Service"]),
    Layer.succeed(GoogleCalendarWorkspaceLimitationsService, {
      listLimitations: () => Effect.succeed([]),
    }),
    lock.layer
  );
  return { services, entered: lock.entered };
};

test("Open Space changes tables by date and keeps the local DST interval", async () => {
  const { services, entered } = capacityLayer({
    tables: [openTable, otherOpenTable],
    providerBookings: [
      providerBooking("10", openTable, startDate),
      providerBooking("11", otherOpenTable, nextDate),
    ],
  });
  const plan = await withUnlimitedPassCapacity(
    { startDate, selection: { tier: "open-space" } },
    Effect.succeed
  ).pipe(Effect.provide(services), Effect.runPromise);

  expect(plan.pinnedDesk).toBeNull();
  expect(plan.days).toHaveLength(30);
  expect(plan.days.slice(0, 2).map(({ tableId }) => tableId)).toEqual([
    otherOpenTable.id,
    openTable.id,
  ]);
  const { startsAt, endsAt } = plan.days[0]!.interval;
  expect(Temporal.Instant.from(endsAt).since(startsAt).total("hours")).toBe(16);
  expect(entered).toEqual(
    plan.days.map(({ serviceDate }) => [
      "reservation-capacity",
      serviceDate.toString(),
    ])
  );
});

test("Reserved Desk excludes a window with free seats every day but no common desk", async () => {
  const { services } = capacityLayer({
    tables: [firstDesk, otherDesk],
    providerBookings: [
      providerBooking("12", firstDesk, startDate),
      providerBooking("13", otherDesk, nextDate),
    ],
  });
  const selection = { tier: "reserved-desk" } as const;
  const bookable = await getBookableUnlimitedStarts({
    selection,
    startsOn: startDate,
    endsBefore: nextDate.add({ days: 1 }),
  }).pipe(Effect.provide(services), Effect.runPromise);
  expect(bookable.map(String)).toEqual([nextDate.toString()]);

  const failure = await withUnlimitedPassCapacity(
    { startDate, selection },
    Effect.succeed
  ).pipe(Effect.flip, Effect.provide(services), Effect.runPromise);
  expect(failure).toMatchObject({
    _tag: "UnlimitedPassCapacityUnavailable",
    reason: "no-common-desk",
  });
});

test("the workstation pins an exact monitor setup", async () => {
  const monitorOption = "2x27-qhd";
  const tags = workspaceProductMonitorOptionTableTags[monitorOption];
  const exact = makeTable("6", ["cowork:reserved-desk", ...tags]);
  const contradictory = makeTable("7", [
    "cowork:reserved-desk",
    ...tags,
    "monitor:size:32",
  ]);
  const { services } = capacityLayer({
    tables: [firstDesk, contradictory, exact],
  });
  const plan = await withUnlimitedPassCapacity(
    {
      startDate,
      selection: { tier: "reserved-desk-workstation", monitorOption },
    },
    Effect.succeed
  ).pipe(Effect.provide(services), Effect.runPromise);
  expect(plan.pinnedDesk).toEqual({ id: exact.id, name: exact.name });
  expect(plan.days.every(({ tableId }) => tableId === exact.id)).toBe(true);
  const { startsAt, endsAt } = plan.days[0]!.interval;
  expect(Temporal.Instant.from(endsAt).since(startsAt).total("hours")).toBe(23);
});

test("ordinary assignment counts a durable intent and deduplicates its visible provider hold", async () => {
  const serviceDate = plainDateStringSchema.make(startDate.toString());
  const intent = {
    tableId: openTable.id,
    serviceDate,
    passId,
    customerId,
    tier: "open-space",
  } as const;
  const interval = getCoworkReservationInterval("open-space", serviceDate);
  const day = { tableId: openTable.id, serviceDate: startDate, interval };
  const record = await createUnlimitedPassDayHold({
    passId,
    customerId,
    day,
  }).pipe(
    Effect.provideService(DotyposService, {
      createReservation: ({ note }) =>
        Effect.succeed({
          ...providerBooking("15", openTable, startDate),
          startDate: interval.startsAt,
          endDate: interval.endsAt,
          seats: "1",
          status: "NEW",
          note,
        }),
    } as DotyposService["Service"]),
    Effect.runPromise
  );
  expect(hasUnlimitedPassDayMarker(record, passId, startDate)).toBe(true);
  expect(matchesUnlimitedPassDayHold(record, { passId, customerId, day })).toBe(
    true
  );

  const assigned = ({
    tables,
    providerBookings,
  }: {
    tables: readonly DotyposTable[];
    providerBookings?: readonly DotyposReservation[];
  }) => {
    const { services } = capacityLayer({
      tables,
      providerBookings,
      intents: [intent],
    });
    return Effect.flatMap(WorkspaceTableAssignmentService, (service) =>
      service.assignTableId({
        kind: "cowork",
        entryTier: "open-space",
        date: serviceDate,
        coffee: false,
      })
    ).pipe(
      Effect.provide(
        WorkspaceTableAssignmentService.Default.pipe(Layer.provide(services))
      ),
      Effect.runPromise
    );
  };

  await expect(
    assigned({ tables: [{ ...openTable, seats: "1" }] })
  ).rejects.toMatchObject({ _tag: "TableAssignmentUnavailableError" });
  await expect(
    assigned({ tables: [openTable], providerBookings: [record] })
  ).resolves.toBe(openTable.id);

  const cancelled = { ...record, status: "CANCELLED" } as const;
  const other = { ...record, note: `${record.note} altered` };
  const listed = await listUnlimitedPassDayHolds({
    passId,
    customerId,
    startDate,
  }).pipe(
    Effect.provideService(DotyposService, {
      listReservations: () =>
        Effect.succeed([record, cancelled, { ...other, note: "unrelated" }]),
    } as DotyposService["Service"]),
    Effect.runPromise
  );
  expect(listed).toEqual([record, cancelled]);
});
