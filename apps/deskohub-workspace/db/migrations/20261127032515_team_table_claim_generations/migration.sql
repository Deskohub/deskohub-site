ALTER TABLE "team_table_hold_claims" ADD COLUMN "generation" uuid;--> statement-breakpoint
ALTER TABLE "team_table_hold_claims" ADD COLUMN "purpose" text DEFAULT 'checkout' NOT NULL;--> statement-breakpoint
ALTER TABLE "team_table_hold_claims" ADD COLUMN "payment_attempt_id" text;--> statement-breakpoint
ALTER TABLE "team_table_hold_claims" ADD COLUMN "attached_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "team_table_hold_claims" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "team_table_hold_claims" ADD CONSTRAINT "team_table_hold_claims_owner" CHECK (
      ("purpose" = 'checkout' and "payment_attempt_id" is null)
      or ("purpose" in ('payment_retry', 'late_payment') and
        "payment_attempt_id" is not null and "generation" is not null)
    );