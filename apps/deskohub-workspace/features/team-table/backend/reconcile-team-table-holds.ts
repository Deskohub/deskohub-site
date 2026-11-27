import { DotyposService } from "@deskohub/dotypos";
import { and, eq, lte, sql } from "drizzle-orm";
import { Effect } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { teamTableHoldClaims, workspaceReservations } from "@/db/schema";
import { WorkspaceLockSections } from "@/db/workspace-locks";
import { formatPaymentOrderLine } from "@/features/checkout/backend/reservation/order-reservation-note";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import { getTouchedWorkspaceDateBounds } from "@/features/reservation/reservation-date";
import {
  getPlainDatesBetween,
  temporalInstantToDate,
} from "@/shared/utils/temporal";
import { TeamTableHoldClaims } from "./team-table-hold-claims";

/** Retire unpaid Team Table holds whose create outcome was uncertain. */
export const reconcileTeamTableHolds = Effect.fn("reconcileTeamTableHolds")(
  function* ({
    now,
    limit,
  }: {
    readonly now: Temporal.Instant;
    readonly limit: number;
  }) {
    const { db, transaction } = yield* WorkspaceDatabase;
    const dotypos = yield* DotyposService;
    const reservations = yield* WorkspaceReservationRepository;
    const claims = yield* TeamTableHoldClaims;
    const selected = yield* db
      .select({
        claim: teamTableHoldClaims,
        authorAccountId: workspaceReservations.authorAccountId,
      })
      .from(teamTableHoldClaims)
      .innerJoin(
        workspaceReservations,
        eq(workspaceReservations.id, teamTableHoldClaims.reservationId)
      )
      .where(
        and(
          eq(workspaceReservations.reservationState, "creating_hold"),
          lte(workspaceReservations.reservationHoldExpiresAt, now)
        )
      )
      .orderBy(
        sql`${teamTableHoldClaims.checkedAt} asc nulls first`,
        teamTableHoldClaims.reservationId
      )
      .limit(limit);
    for (const { claim, authorAccountId } of selected) {
      const id = claim.reservationId;
      const dates = getTouchedWorkspaceDateBounds(claim);
      const retire = Effect.gen(function* () {
        const row = yield* reservations.findById(id);
        if (
          row?.reservationState !== "creating_hold" ||
          !row.reservationHoldExpiresAt ||
          Temporal.Instant.compare(row.reservationHoldExpiresAt, now) > 0
        )
          return;
        yield* db
          .update(teamTableHoldClaims)
          .set({ checkedAt: now })
          .where(eq(teamTableHoldClaims.reservationId, id));
        const record = yield* claims.recover(id, row.dotyposCustomerId);
        if (record) {
          yield* dotypos.setReservationStatusIfMatches({
            reservationId: record.id,
            expectedBooking: {
              customerId: row.dotyposCustomerId,
              tableId: claim.tableId,
              seats: claim.seats,
              startDate: temporalInstantToDate(claim.startsAt),
              endDate: temporalInstantToDate(claim.endsAt),
            },
            expectedNoteLine: formatPaymentOrderLine(id),
            expectedCurrentStatus: "NEW",
            status: "CANCELLED",
          });
        } else if (Temporal.Instant.compare(claim.endsAt, now) > 0) {
          // An absent or ambiguous provider receipt still might occupy the
          // interval. Keep its capacity until the interval ends.
          return;
        }
        yield* transaction(
          claims
            .clear(id)
            .pipe(Effect.andThen(reservations.releaseHoldCreation(id)))
        );
      });
      yield* WorkspaceLockSections.reservationCapacity(
        getPlainDatesBetween(dates.first, dates.last),
        { movedReservations: [id], ...(authorAccountId && { authorAccountId }) }
      )(retire).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Team Table hold needs reconciliation", { cause })
        )
      );
    }
  }
);
