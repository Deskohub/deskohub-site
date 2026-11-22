import "server-only";

import type { DotyposReservationId } from "@deskohub/dotypos";
import type {
  AutomationTrigger,
  ReservationPayment,
  ReservationStay,
} from "@deskohub/workspace-admin-api";
import { Option } from "effect";
import type { WorkspaceDatabaseClient } from "@/db/database.service";
import type { WorkspaceCoworkProductTier } from "@/features/checkout/product-catalog";
import type { ReservationVisit } from "@/features/reservation/backend/reservation-visits.service";
import { isBookedStay, loadCoworkTiers } from "../../backend/reservation-stay";
import { readsTriggeringVisit } from "../automation-trigger-verification";
import { automationTriggerKind } from "../automation-triggers";

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
 * Whether taking in an event of the trigger reads its reservation's live
 * visit: for the re-check (D35), or to judge the trigger's stay (D1).
 */
export const readsTriggerVisit = (trigger: AutomationTrigger): boolean =>
  readsTriggeringVisit(automationTriggerKind(trigger)) ||
  Option.isSome(triggerStay(trigger));

/** Stored cowork tiers by Dotypos reservation, which a visit's stay needs. */
export type TriggeringVisitTiers = ReadonlyMap<
  DotyposReservationId,
  WorkspaceCoworkProductTier
>;

/** The stored cowork tiers of the triggering visits Dotypos returned. */
export const triggeringVisitTiers = (
  db: WorkspaceDatabaseClient,
  visits: Iterable<Option.Option<ReservationVisit>>
) =>
  loadCoworkTiers(db, [
    ...new Set(
      [...visits].flatMap((visit) =>
        Option.match(visit, {
          onNone: () => [],
          onSome: ({ dotyposReservationId }) => [dotyposReservationId],
        })
      )
    ),
  ]);

/**
 * Whether the triggering visit is of the trigger's stay (D1): always
 * without one. Otherwise its booked interval and stored cowork tier must
 * give that stay; a visit Dotypos no longer returns, or one without a
 * Workspace cowork tier, is of no stay.
 */
export const isOfTriggerStay = (
  stay: Option.Option<ReservationStay>,
  visit: Option.Option<ReservationVisit>,
  tiers: TriggeringVisitTiers
): boolean =>
  Option.match(stay, {
    onNone: () => true,
    onSome: (stay) =>
      Option.exists(visit, (visit) =>
        isBookedStay(stay, {
          tier: tiers.get(visit.dotyposReservationId),
          interval: visit,
        })
      ),
  });
