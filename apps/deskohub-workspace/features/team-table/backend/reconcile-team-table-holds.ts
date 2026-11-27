import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { Effect } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { teamTableHoldClaims, workspaceReservations } from "@/db/schema";
import { WorkspaceLockSections } from "@/db/workspace-locks";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import {
  getTouchedWorkspaceDateBounds,
  getWorkspaceDate,
} from "@/features/reservation/reservation-date";
import { getPlainDatesBetween } from "@/shared/utils/temporal";
import { TeamTableHoldClaims } from "./team-table-hold-claims";

/** Close expired checkout attempts and retire their generation's provider hold. */
export const reconcileTeamTableHolds = Effect.fn("reconcileTeamTableHolds")(
  function* ({
    now,
    limit,
  }: {
    readonly now: Temporal.Instant;
    readonly limit: number;
  }) {
    const { db } = yield* WorkspaceDatabase;
    const reservations = yield* WorkspaceReservationRepository;
    const claims = yield* TeamTableHoldClaims;
    const selected = yield* db
      .select({
        id: workspaceReservations.id,
        claim: teamTableHoldClaims,
        authorAccountId: workspaceReservations.authorAccountId,
      })
      .from(workspaceReservations)
      .leftJoin(
        teamTableHoldClaims,
        eq(workspaceReservations.id, teamTableHoldClaims.reservationId)
      )
      .where(
        or(
          and(
            lte(workspaceReservations.reservationHoldExpiresAt, now),
            isNull(workspaceReservations.dotyposReservationId),
            or(
              and(
                eq(workspaceReservations.reservationState, "creating_hold"),
                sql`${workspaceReservations.reservationDetails}->>'kind' = 'table'`
              ),
              and(
                eq(workspaceReservations.reservationState, "hold_expired"),
                eq(teamTableHoldClaims.purpose, "checkout")
              )
            )
          ),
          and(
            isNull(teamTableHoldClaims.retiredAt),
            isNotNull(teamTableHoldClaims.cancelRequestedAt)
          ),
          and(
            inArray(teamTableHoldClaims.purpose, [
              "payment_retry",
              "late_payment",
            ]),
            isNull(teamTableHoldClaims.attachedAt),
            isNull(teamTableHoldClaims.retiredAt),
            lte(teamTableHoldClaims.endsAt, now)
          )
        )
      )
      .orderBy(
        sql`${teamTableHoldClaims.checkedAt} asc nulls first`,
        workspaceReservations.id
      )
      .limit(limit);
    for (const { id, claim, authorAccountId } of selected) {
      const dates = claim ? getTouchedWorkspaceDateBounds(claim) : null;
      const retire = Effect.gen(function* () {
        const row = yield* reservations.findById(id);
        const fresh = yield* claims.find(id);
        if (!row || fresh?.generation !== claim?.generation) return;
        const expiredCheckout =
          (!fresh || fresh.purpose === "checkout") &&
          !row.dotyposReservationId &&
          (row.reservationState === "creating_hold" ||
            row.reservationState === "hold_expired") &&
          row.reservationHoldExpiresAt !== null &&
          Temporal.Instant.compare(row.reservationHoldExpiresAt, now) <= 0;
        if (expiredCheckout) yield* claims.expireCheckout(id, now);
        if (!fresh) return;
        // A crash after the local attach may leave only its provider id
        // recorded. That committed attachment supersedes cancellation.
        if (
          row.dotyposReservationId &&
          fresh.providerReservationIds?.includes(row.dotyposReservationId) &&
          (row.reservationState === "held" ||
            row.reservationState === "confirming" ||
            row.reservationState === "confirmed")
        ) {
          yield* claims.attached(fresh, row.dotyposReservationId, now);
          return;
        }
        const ended = Temporal.Instant.compare(fresh.endsAt, now) <= 0;
        if (!expiredCheckout && !fresh.cancelRequestedAt && !ended) return;
        yield* db
          .update(teamTableHoldClaims)
          .set({ checkedAt: now })
          .where(eq(teamTableHoldClaims.reservationId, id));

        const receipt = yield* claims.inspect(fresh, row.dotyposCustomerId);
        let cancelledId =
          receipt.kind === "cancelled" ? receipt.record.id : undefined;
        if (receipt.kind === "active") {
          const expected =
            fresh.purpose === "late_payment" ? "CONFIRMED" : "NEW";
          if (receipt.record.status !== expected) {
            if (!ended) return;
          } else {
            if (
              !(yield* claims.cancel(
                fresh,
                row.dotyposCustomerId,
                receipt.record
              ))
            )
              return;
            cancelledId = receipt.record.id;
          }
        } else if (receipt.kind === "absent") {
          cancelledId = fresh.providerReservationIds?.[0];
        } else if (receipt.kind === "unresolved" && !ended) {
          return;
        }
        if (fresh.purpose === "checkout") {
          yield* claims.finishCheckout(fresh, now, cancelledId);
        } else {
          yield* claims.retire(fresh, now);
        }
      });
      yield* WorkspaceLockSections.reservationCapacity(
        dates
          ? getPlainDatesBetween(dates.first, dates.last)
          : [getWorkspaceDate(now)],
        { movedReservations: [id], authorAccountId }
      )(retire).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Team Table hold needs reconciliation", { cause })
        )
      );
    }
  }
);
