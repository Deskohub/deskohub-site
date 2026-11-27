import {
  type DotyposReservation,
  type DotyposReservationId,
  DotyposService,
  type DotyposTableId,
} from "@deskohub/dotypos";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer, Option } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { teamTableHoldClaims } from "@/db/schema";
import { noteNamesPaymentOrder } from "@/features/checkout/backend/reservation/order-reservation-note";
import { decodeBookedReservation } from "@/features/reservation/backend/booked-reservation";
import type { DotyposCustomerId } from "@/features/reservation/dotypos-customer";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import type { TableReservationDetails } from "@/features/reservation/table-reservation";
import { temporalInstantToDate } from "@/shared/utils/temporal";

type HoldClaim = typeof teamTableHoldClaims.$inferSelect;

export const matchesTeamTableHold = (
  record: DotyposReservation,
  expected: Pick<
    HoldClaim,
    "reservationId" | "tableId" | "seats" | "startsAt" | "endsAt"
  >,
  customerId: DotyposCustomerId
) => {
  const { interval, seats } = decodeBookedReservation(record);
  return (
    record.status === "NEW" &&
    record._customerId === customerId &&
    record._tableId === expected.tableId &&
    noteNamesPaymentOrder(record.note, expected.reservationId) &&
    Option.contains(seats, expected.seats) &&
    Option.exists(
      interval,
      ({ startsAt, endsAt }) =>
        startsAt.equals(expected.startsAt) && endsAt.equals(expected.endsAt)
    )
  );
};

export const getTeamTableHoldClaim = (
  reservationId: WorkspaceReservationId,
  tableId: DotyposTableId,
  { startsAt, endsAt, seats }: TableReservationDetails
) => ({
  reservationId,
  tableId,
  startsAt: Temporal.Instant.from(startsAt),
  endsAt: Temporal.Instant.from(endsAt),
  seats,
});

const makeTeamTableHoldClaims = Effect.gen(function* () {
  const { db } = yield* WorkspaceDatabase;
  const dotypos = yield* DotyposService;

  const find = (id: WorkspaceReservationId) =>
    db
      .select()
      .from(teamTableHoldClaims)
      .where(eq(teamTableHoldClaims.reservationId, id))
      .pipe(Effect.map(([claim]) => claim));

  const start = (claim: ReturnType<typeof getTeamTableHoldClaim>) =>
    db
      .insert(teamTableHoldClaims)
      .values(claim)
      .onConflictDoNothing()
      .returning({
        id: teamTableHoldClaims.reservationId,
      })
      .pipe(Effect.map((inserted) => inserted.length === 1));

  const remember = (
    id: WorkspaceReservationId,
    providerIds: readonly DotyposReservationId[]
  ) =>
    db
      .update(teamTableHoldClaims)
      .set({
        providerReservationIds: [...new Set(providerIds)],
      })
      .where(eq(teamTableHoldClaims.reservationId, id));

  const clear = (id: WorkspaceReservationId) =>
    db
      .delete(teamTableHoldClaims)
      .where(eq(teamTableHoldClaims.reservationId, id));

  /**
   * Find one active hold uniquely linked to the order and matching its entire
   * claim. An incomplete reply can hide a provider write, so absence preserves
   * the local claim and does not authorize another POST.
   */
  const recover = Effect.fn("TeamTableHoldClaims.recover")(function* (
    id: WorkspaceReservationId,
    customerId: DotyposCustomerId
  ) {
    const claim = yield* find(id);
    if (!claim || (claim.providerReservationIds?.length ?? 0) > 1)
      return undefined;
    const records = yield* dotypos.listActiveReservationsOverlapping({
      startDate: temporalInstantToDate(claim.startsAt),
      endDate: temporalInstantToDate(claim.endsAt),
    });
    const observedIds = records
      .filter(({ note }) => noteNamesPaymentOrder(note, id))
      .map(({ id: providerId }) => providerId);
    const ids = new Set([
      ...(claim.providerReservationIds ?? []),
      ...observedIds,
    ]);
    if (ids.size !== 1) return undefined;
    const providerId = ids.values().next().value;
    if (!providerId) return undefined;
    const record = yield* dotypos
      .getReservationWithoutCustomer(providerId)
      .pipe(
        Effect.catchTag("DotyposRejected", (error) =>
          error.reason === "not-found"
            ? Effect.succeed(undefined)
            : Effect.fail(error)
        )
      );
    return record && matchesTeamTableHold(record, claim, customerId)
      ? record
      : undefined;
  });

  return { find, start, remember, clear, recover };
});

export class TeamTableHoldClaims extends Context.Service<
  TeamTableHoldClaims,
  Effect.Success<typeof makeTeamTableHoldClaims>
>()("TeamTableHoldClaims") {
  static Default = Layer.effect(this, makeTeamTableHoldClaims);
}
