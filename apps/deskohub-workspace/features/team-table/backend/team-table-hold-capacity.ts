import { and, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import { Effect } from "effect";
import type { WorkspaceDatabaseClient } from "@/db/database.service";
import { teamTableHoldClaims, workspaceReservations } from "@/db/schema";
import type { LocalTableCapacityClaim } from "@/features/reservation/backend/open-space-move-capacity";
import { workspaceSiteConstants } from "@/shared/utils/site-constants";
import {
  currentInstant,
  plainDateSpanToInstants,
} from "@/shared/utils/temporal";

export const loadTeamTableHoldCapacity = Effect.fnUntraced(function* (
  db: WorkspaceDatabaseClient,
  {
    first,
    last,
  }: { readonly first: Temporal.PlainDate; readonly last: Temporal.PlainDate }
) {
  const { startsAt, endsAt } = plainDateSpanToInstants({
    startsOn: first,
    endsOn: last,
    timeZone: workspaceSiteConstants.location.timeZone,
  });
  const now = yield* currentInstant;
  const claims = yield* db
    .select({
      claim: teamTableHoldClaims,
      reservationId: workspaceReservations.dotyposReservationId,
    })
    .from(teamTableHoldClaims)
    .innerJoin(
      workspaceReservations,
      eq(workspaceReservations.id, teamTableHoldClaims.reservationId)
    )
    .where(
      and(
        lt(teamTableHoldClaims.startsAt, endsAt),
        gt(teamTableHoldClaims.endsAt, startsAt),
        gt(teamTableHoldClaims.endsAt, now),
        or(
          eq(workspaceReservations.reservationState, "creating_hold"),
          and(
            sql`${workspaceReservations.dotyposReservationId} = any(${teamTableHoldClaims.providerReservationIds})`,
            or(
              inArray(workspaceReservations.reservationState, [
                "confirmed",
                "cancelling",
              ]),
              and(
                eq(workspaceReservations.reservationState, "held"),
                gt(workspaceReservations.reservationHoldExpiresAt, now)
              )
            )
          )
        )
      )
    );
  return claims.map(
    ({ claim, reservationId }) =>
      ({
        reservationId,
        generation: null,
        tableId: claim.tableId,
        startsAt: claim.startsAt.epochMilliseconds,
        endsAt: claim.endsAt.epochMilliseconds,
        seats: claim.seats,
        exclusive: true,
      }) satisfies LocalTableCapacityClaim
  );
});
