CREATE TABLE "unlimited_auto_renewal_authorizations" (
	"payment_attempt_id" text PRIMARY KEY,
	"holder_version" integer NOT NULL,
	"next_renewal_on" date NOT NULL,
	"amount_value" integer NOT NULL,
	"amount_exponent" integer NOT NULL,
	"currency" text NOT NULL,
	"terms_path" text NOT NULL,
	"terms_hash" text NOT NULL,
	"quote_fingerprint" text NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"cancelled_at" timestamp with time zone,
	"prepaid_successor_order_id" text,
	CONSTRAINT "unlimited_auto_renewal_amount_check" CHECK ("amount_value" > 0 and "amount_exponent" >= 0 and "currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "unlimited_auto_renewal_evidence_check" CHECK ("terms_hash" ~ '^[0-9a-f]{64}$' and "quote_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "unlimited_auto_renewal_stop_check" CHECK ("cancelled_at" is null or "prepaid_successor_order_id" is null)
);
--> statement-breakpoint
ALTER TABLE "pass_purchases" ADD COLUMN "auto_renew" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "unlimited_auto_renewal_authorizations" ADD CONSTRAINT "unlimited_auto_renewal_authorizations_XhbSKmEZsaT8_fkey" FOREIGN KEY ("payment_attempt_id") REFERENCES "payment_attempts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "unlimited_auto_renewal_authorizations" ADD CONSTRAINT "unlimited_auto_renewal_authorizations_G3d6tc2EZ5MT_fkey" FOREIGN KEY ("prepaid_successor_order_id") REFERENCES "orders"("id");--> statement-breakpoint
ALTER TABLE "pass_purchases" ADD CONSTRAINT "pass_purchases_auto_renew_check" CHECK (not "auto_renew" or "product" = 'unlimited');