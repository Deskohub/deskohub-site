import { sql } from "drizzle-orm";
import { check, pgTable, text } from "drizzle-orm/pg-core";

export const paymentProviderFallbacks = pgTable(
  "payment_provider_fallbacks",
  {
    deploymentHostHash: text("deployment_host_hash").primaryKey(),
  },
  (t) => [
    check(
      "payment_provider_fallbacks_deployment_host_hash_check",
      sql`${t.deploymentHostHash} ~ '^[0-9a-f]{64}$'`
    ),
  ]
);
