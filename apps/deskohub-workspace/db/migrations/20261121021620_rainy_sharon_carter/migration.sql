CREATE TABLE "unlimited_pass_supersessions" (
	"buyer_account_id" text,
	"order_id" uuid,
	CONSTRAINT "unlimited_pass_supersessions_pkey" PRIMARY KEY("buyer_account_id","order_id")
);
--> statement-breakpoint
ALTER TABLE "unlimited_pass_supersessions" ADD CONSTRAINT "unlimited_pass_supersessions_jQBu0VWIqPPM_fkey" FOREIGN KEY ("buyer_account_id") REFERENCES "customer_accounts"("id");