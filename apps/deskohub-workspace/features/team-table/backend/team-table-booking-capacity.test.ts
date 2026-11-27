import { expect, test } from "bun:test";
import {
  DotyposReservationIdSchema,
  DotyposTableIdSchema,
} from "@deskohub/dotypos";
import { Effect, Layer } from "effect";
import { WorkspaceDatabaseAdvisoryLock } from "@/db/postgres-advisory-lock";
import { customerAccountIdSchema } from "@/features/account/customer-account";
import { WorkspaceAvailabilityService } from "@/features/reservation/backend/workspace-availability.service";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import {
  instantStringSchema,
  plainDateStringSchema,
} from "@/shared/utils/temporal";
import { OpenSpaceTableMoves } from "./open-space-table-moves";
import { withTeamTableBookingCapacity } from "./team-table-booking-capacity";

test("rediscovers changed source locks before moving and checks the exact table before the hold", async () => {
  const tableId = DotyposTableIdSchema.make("four-seat-table");
  const serviceDate = plainDateStringSchema.make("2027-01-11");
  const reservation = {
    kind: "table" as const,
    seats: 4,
    startsAt: instantStringSchema.make("2027-01-11T09:00:00Z"),
    endsAt: instantStringSchema.make("2027-01-11T09:15:00Z"),
  };
  const authorAccountId = customerAccountIdSchema.make("author");
  const oldId = workspaceReservationIdSchema.make("first-source");
  const newId = workspaceReservationIdSchema.make("second-source");
  const source = (reservationId: typeof oldId) => ({
    reservationId,
    sourceReservationId: DotyposReservationIdSchema.make(reservationId),
    targetTableId: DotyposTableIdSchema.make("open-space"),
    serviceDate,
    status: "CONFIRMED" as const,
    startsAt: Temporal.Instant.from("2027-01-10T23:00:00Z"),
    endsAt: Temporal.Instant.from("2027-01-11T16:00:00Z"),
  });
  const calls: unknown[] = [];
  let reads = 0;
  const result = await withTeamTableBookingCapacity(
    { reservation, authorAccountId },
    ({ assignTableId }) =>
      Effect.tap(assignTableId, (id) =>
        Effect.sync(() => calls.push(["create", id]))
      )
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(WorkspaceAvailabilityService, {
          getLiveTeamTablePlan: (_reservation, exactId) =>
            Effect.sync(() => {
              if (exactId) {
                calls.push(["verify", exactId]);
                return { tableId, moves: [] };
              }
              return {
                tableId,
                moves: [source(reads++ === 0 ? oldId : newId)],
              };
            }),
        }),
        Layer.mock(WorkspaceDatabaseAdvisoryLock, {
          withLocks: (keys, effect) =>
            Effect.sync(() => calls.push(keys)).pipe(Effect.andThen(effect)),
        }),
        Layer.mock(OpenSpaceTableMoves, {
          repackInCapacitySection: ({ moves }) =>
            Effect.sync(() => {
              calls.push([
                "repack",
                moves.map(({ reservationId }) => reservationId),
              ]);
              return true;
            }),
        })
      )
    ),
    Effect.runPromise
  );
  expect(result).toBe(tableId);
  expect(calls).toEqual([
    [
      ["reservation-order", oldId],
      ["customer-account", authorAccountId],
      ["reservation-capacity", serviceDate],
    ],
    [
      ["reservation-order", newId],
      ["customer-account", authorAccountId],
      ["reservation-capacity", serviceDate],
    ],
    ["repack", [newId]],
    ["verify", tableId],
    ["create", tableId],
  ]);
});
