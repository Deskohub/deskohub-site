CREATE TABLE "team_table_hold_claims" (
	"reservation_id" text PRIMARY KEY,
	"table_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"seats" integer NOT NULL,
	"provider_reservation_ids" text[],
	"checked_at" timestamp with time zone,
	CONSTRAINT "team_table_hold_claims_interval" CHECK ("starts_at" < "ends_at"),
	CONSTRAINT "team_table_hold_claims_seats" CHECK ("seats" > 0)
);
--> statement-breakpoint
CREATE INDEX "team_table_hold_claims_interval_idx" ON "team_table_hold_claims" ("ends_at","starts_at");--> statement-breakpoint
ALTER TABLE "team_table_hold_claims" ADD CONSTRAINT "team_table_hold_claims_GG82H69LKXnb_fkey" FOREIGN KEY ("reservation_id") REFERENCES "workspace_reservations"("id") ON DELETE CASCADE;