ALTER TABLE "workspace_reservations" ADD COLUMN "pass_day_hold_generation" uuid;--> statement-breakpoint
ALTER TABLE "workspace_reservations" DROP CONSTRAINT "workspace_reservations_pass_day_check", ADD CONSTRAINT "workspace_reservations_pass_day_check" CHECK (("pass_id" is null and "service_date" is null and "pass_day_table_id" is null
          and "pass_day_hold_requested_at" is null and "pass_day_hold_generation" is null)
        or ("pass_id" is not null and "service_date" is not null and "pass_day_table_id" is not null
          and "active_payment_attempt_id" is null and "active_customer_email_delivery_id" is null));