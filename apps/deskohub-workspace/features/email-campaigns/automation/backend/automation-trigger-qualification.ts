import "server-only";

import { DotyposService } from "@deskohub/dotypos";
import type {
  AutomationTrigger,
  ReservationPayment,
  ReservationStay,
} from "@deskohub/workspace-admin-api";
import { and, inArray, isNotNull } from "drizzle-orm";
import { Effect, Option } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { workspaceReservations } from "@/db/schema";
import type { WorkspaceCoworkProductTier } from "@/features/checkout/product-catalog";
import {
  type BookedInterval,
  decodeBookedReservation,
} from "@/features/reservation/backend/booked-reservation";
import { StoredReservationDetails } from "@/features/reservation/backend/stored-reservation-details.server";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import { isBookedStay, loadCoworkTiers } from "../../backend/reservation-stay";
import { readsTriggeringVisit } from "../automation-trigger-verification";
import { automationTriggerKind } from "../automation-triggers";
import { AutomationUnitFetchFailure } from "./automation-unit-handler";

/** The stay a reservation trigger's visit must be of; none when unset (D1). */
export const triggerStay = (
  trigger: AutomationTrigger
): Option.Option<ReservationStay> =>
  Option.fromUndefinedOr("stay" in trigger ? trigger.stay : undefined);

/** How a reservation trigger's reservation must be paid; none when unset (D1). */
export const triggerPayment = (
  trigger: AutomationTrigger
): Option.Option<ReservationPayment> =>
  Option.fromUndefinedOr("payment" in trigger ? trigger.payment : undefined);

/**
 * How many times taking in an event of the trigger reads its reservation's
 * visit from Dotypos: for the re-check (D35), and for the stay (D1).
 */
export const triggerVisitReads = (trigger: AutomationTrigger): number =>
  (readsTriggeringVisit(automationTriggerKind(trigger)) ? 1 : 0) +
  (Option.isSome(triggerStay(trigger)) ? 1 : 0);

/** A triggering visit as its stay needs it. */
export type StayVisit = {
  /** The stored cowork tier; none for another family. */
  readonly tier: WorkspaceCoworkProductTier | undefined;
  /** The booked interval Dotypos returns. */
  readonly interval: BookedInterval;
};

/**
 * The visits of stay triggers' reservations (D1), at most one Dotypos
 * request per 100. Unlike the re-check's visits, these include
 * reservations Workspace cancelled: a cancellation trigger fires on one,
 * and cancelling doesn't change a visit's stay. A reservation without a
 * Dotypos reservation, one Dotypos doesn't return, or one whose interval
 * doesn't decode is absent, so of no stay.
 */
export const loadStayVisits = (
  reservationIds: readonly WorkspaceReservationId[]
): Effect.Effect<
  ReadonlyMap<WorkspaceReservationId, StayVisit>,
  AutomationUnitFetchFailure,
  WorkspaceDatabase | DotyposService
> =>
  reservationIds.length === 0
    ? Effect.succeed(new Map())
    : Effect.gen(function* () {
        const { db } = yield* WorkspaceDatabase;
        const dotypos = yield* DotyposService;
        const databaseFailure = (cause: unknown) =>
          new AutomationUnitFetchFailure({ code: "database", cause });
        const rows = yield* db
          .select({
            id: workspaceReservations.id,
            dotyposReservationId: workspaceReservations.dotyposReservationId,
            reservationDetails: workspaceReservations.reservationDetails,
          })
          .from(workspaceReservations)
          .where(
            and(
              inArray(workspaceReservations.id, [...reservationIds]),
              isNotNull(workspaceReservations.dotyposReservationId)
            )
          )
          .pipe(Effect.mapError(databaseFailure));
        const linked = rows.flatMap(({ dotyposReservationId, ...row }) =>
          dotyposReservationId === null
            ? []
            : [{ ...row, dotyposReservationId }]
        );
        const dotyposIds = linked.map(
          ({ dotyposReservationId }) => dotyposReservationId
        );
        const tiers = yield* loadCoworkTiers(db, dotyposIds).pipe(
          Effect.mapError(databaseFailure)
        );
        const reservations = yield* dotypos
          .getReservationsByIds(dotyposIds, { concurrency: 1 })
          .pipe(Effect.mapError(AutomationUnitFetchFailure.fromDotypos));
        return new Map(
          linked.flatMap(({ id, dotyposReservationId, reservationDetails }) => {
            const reservation = reservations.get(dotyposReservationId);
            if (reservation === undefined) return [];
            const booked = decodeBookedReservation(
              reservation,
              Option.getOrUndefined(
                StoredReservationDetails.project(reservationDetails)
              )
            );
            return Option.match(booked.interval, {
              onNone: () => [],
              onSome: (interval) => [
                [
                  id,
                  { tier: tiers.get(dotyposReservationId), interval },
                ] as const,
              ],
            });
          })
        );
      });

/**
 * Whether the triggering visit is of the trigger's stay (D1): always
 * without one. Otherwise its booked interval and stored cowork tier must
 * give that stay.
 */
export const isOfTriggerStay = (
  stay: Option.Option<ReservationStay>,
  visit: Option.Option<StayVisit>
): boolean =>
  Option.match(stay, {
    onNone: () => true,
    onSome: (stay) =>
      Option.exists(visit, (visit) => isBookedStay(stay, visit)),
  });
