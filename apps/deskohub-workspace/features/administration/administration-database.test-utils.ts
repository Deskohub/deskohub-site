import {
  DotyposCloudIdSchema,
  DotyposReservationIdSchema,
} from "@deskohub/dotypos";
import { Effect, Layer } from "effect";
import type { WorkspaceDatabase } from "@/db/database.service";
import type { WorkspaceReservationDetails } from "@/features/reservation/backend/workspace-reservation.service";
import { workspaceReservationFixture } from "@/features/reservation/backend/workspace-reservation.test-utils";
import { makeRecordingWorkspaceDatabase } from "@/shared/testing/workspace-recording-database.test-utils";

export interface StubDatabaseQuery<A> extends Effect.Effect<readonly A[]> {
  readonly from: () => StubDatabaseQuery<A>;
  readonly groupBy: () => StubDatabaseQuery<A>;
  readonly innerJoin: () => StubDatabaseQuery<A>;
  readonly limit: () => StubDatabaseQuery<A>;
  readonly offset: () => StubDatabaseQuery<A>;
  readonly orderBy: () => StubDatabaseQuery<A>;
  readonly where: () => StubDatabaseQuery<A>;
}

/**
 * Chainable Effect-returning query builder stub for unit tests that supply
 * row arrays directly instead of executing SQL against Postgres.
 */
export const makeStubDatabaseQuery = <A>(
  rows: readonly A[]
): StubDatabaseQuery<A> => {
  const self = (): StubDatabaseQuery<A> => query;
  const query: StubDatabaseQuery<A> = Object.assign(Effect.succeed(rows), {
    from: self,
    groupBy: self,
    innerJoin: self,
    limit: self,
    offset: self,
    orderBy: self,
    where: self,
  });
  return query;
};

/**
 * Builds a `WorkspaceDatabase` layer backed by a real recording Drizzle client
 * with selected client methods overridden for unit tests.
 */
export const stubWorkspaceDatabaseLayer = (overrides: {
  readonly select?: (...args: never[]) => unknown;
}): Layer.Layer<WorkspaceDatabase> =>
  Layer.unwrap(
    Effect.promise(async () => {
      const recording = await makeRecordingWorkspaceDatabase();
      if (overrides.select) {
        Reflect.set(recording.db, "select", overrides.select);
      }
      return recording.layer;
    })
  );

/**
 * A confirmed `WorkspaceReservationDetails` fixture for administration service
 * tests, with `overrides` applied.
 */
export const workspaceReservationDetailsFixture = (
  overrides: Partial<WorkspaceReservationDetails> = {}
): WorkspaceReservationDetails => {
  const reservation = workspaceReservationFixture();
  const reservedFrom = Temporal.Instant.from("2099-06-01T08:00:00Z");
  const reservedUntil = Temporal.Instant.from("2099-06-01T16:00:00Z");
  return {
    id: reservation.id,
    dotyposCustomerId: reservation.dotyposCustomerId,
    authorAccountId: reservation.authorAccountId,
    reservationDetails: reservation.reservationDetails,
    locale: reservation.locale,
    dotyposReservationId: DotyposReservationIdSchema.make(
      "dotypos-reservation-1"
    ),
    customer: {
      id: reservation.dotyposCustomerId,
      _cloudId: DotyposCloudIdSchema.make("cloud-1"),
      points: null,
      flags: "0",
      display: true,
      deleted: false,
    },
    reservedFrom,
    reservedUntil,
    providerStatus: "CONFIRMED",
    seats: 1,
    placement: {},
    ...overrides,
  };
};
