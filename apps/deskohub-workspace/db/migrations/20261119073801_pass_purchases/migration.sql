CREATE TABLE "pass_entry_claims" (
	"reservation_id" text PRIMARY KEY,
	"pass_id" text NOT NULL,
	"date" date NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "pass_entry_claims_status_check" CHECK ("status" in ('reserved', 'consumed', 'released'))
);
--> statement-breakpoint
CREATE TABLE "pass_purchases" (
	"id" text PRIMARY KEY,
	"buyer_account_id" text NOT NULL,
	"holder_account_id" text NOT NULL,
	"product" text NOT NULL,
	"tier" text NOT NULL,
	"entry_count" integer NOT NULL,
	"status" text NOT NULL,
	"valid_from" date NOT NULL,
	"valid_until" date NOT NULL,
	"quote" jsonb NOT NULL,
	"locale" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "pass_purchases_product_check" CHECK ("product" = 'entry-pack'),
	CONSTRAINT "pass_purchases_tier_check" CHECK ("tier" in ('open-space', 'reserved-desk', 'reserved-desk-workstation')),
	CONSTRAINT "pass_purchases_entry_count_check" CHECK ("entry_count" in (5, 10)),
	CONSTRAINT "pass_purchases_status_check" CHECK ("status" in ('pending_payment', 'active', 'depleted', 'expired', 'cancelled', 'withdrawn', 'void')),
	CONSTRAINT "pass_purchases_validity_check" CHECK ("valid_from" < "valid_until")
);
--> statement-breakpoint
ALTER TABLE "discount_applications" ALTER COLUMN "workspace_reservation_id" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "pass_entry_claims_pass_date_idx" ON "pass_entry_claims" ("pass_id","date");--> statement-breakpoint
CREATE INDEX "pass_purchases_buyer_idx" ON "pass_purchases" ("buyer_account_id");--> statement-breakpoint
CREATE INDEX "pass_purchases_holder_idx" ON "pass_purchases" ("holder_account_id");--> statement-breakpoint
ALTER TABLE "pass_entry_claims" ADD CONSTRAINT "pass_entry_claims_reservation_id_workspace_reservations_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "workspace_reservations"("id");--> statement-breakpoint
ALTER TABLE "pass_entry_claims" ADD CONSTRAINT "pass_entry_claims_pass_id_pass_purchases_id_fkey" FOREIGN KEY ("pass_id") REFERENCES "pass_purchases"("id");--> statement-breakpoint
ALTER TABLE "pass_purchases" ADD CONSTRAINT "pass_purchases_id_orders_id_fkey" FOREIGN KEY ("id") REFERENCES "orders"("id");--> statement-breakpoint
ALTER TABLE "pass_purchases" ADD CONSTRAINT "pass_purchases_buyer_account_id_customer_accounts_id_fkey" FOREIGN KEY ("buyer_account_id") REFERENCES "customer_accounts"("id");--> statement-breakpoint
ALTER TABLE "pass_purchases" ADD CONSTRAINT "pass_purchases_holder_account_id_customer_accounts_id_fkey" FOREIGN KEY ("holder_account_id") REFERENCES "customer_accounts"("id");