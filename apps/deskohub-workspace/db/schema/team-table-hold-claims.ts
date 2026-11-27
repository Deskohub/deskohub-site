import type { DotyposReservationId, DotyposTableId } from "@deskohub/dotypos";
import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text } from "drizzle-orm/pg-core";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import { instant } from "../instant";
import { workspaceReservations } from "./workspace-reservations";

/** Exclusive capacity reserved before the one-attempt Dotypos create. */
export const teamTableHoldClaims = pgTable(
  "team_table_hold_claims",
  {
    reservationId: text("reservation_id")
      .$type<WorkspaceReservationId>()
      .primaryKey()
      .references(() => workspaceReservations.id, { onDelete: "cascade" }),
    tableId: text("table_id").$type<DotyposTableId>().notNull(),
    startsAt: instant("starts_at").notNull(),
    endsAt: instant("ends_at").notNull(),
    seats: integer("seats").notNull(),
    providerReservationIds: text("provider_reservation_ids")
      .$type<DotyposReservationId>()
      .array(),
    checkedAt: instant("checked_at"),
  },
  (claim) => [
    check(
      "team_table_hold_claims_interval",
      sql`${claim.startsAt} < ${claim.endsAt}`
    ),
    check("team_table_hold_claims_seats", sql`${claim.seats} > 0`),
    index("team_table_hold_claims_interval_idx").on(
      claim.endsAt,
      claim.startsAt
    ),
  ]
);
