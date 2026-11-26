import { sql } from "drizzle-orm";
import { check, date, integer, pgTable, text } from "drizzle-orm/pg-core";
import type { PaymentAttemptId } from "@/features/checkout/checkout-identifiers";
import type { PlainDate } from "@/shared/utils/temporal";
import { instant } from "../instant";
import { paymentAttempts } from "./payment-attempts";

export const unlimitedAutoRenewalAuthorizations = pgTable(
  "unlimited_auto_renewal_authorizations",
  {
    paymentAttemptId: text("payment_attempt_id")
      .primaryKey()
      .$type<PaymentAttemptId>()
      .references(() => paymentAttempts.id, { onDelete: "cascade" }),
    holderVersion: integer("holder_version").notNull(),
    nextRenewalOn: date("next_renewal_on", { mode: "string" })
      .notNull()
      .$type<PlainDate>(),
    amountValue: integer("amount_value").notNull(),
    amountExponent: integer("amount_exponent").notNull(),
    currency: text("currency").notNull(),
    termsPath: text("terms_path").notNull(),
    termsHash: text("terms_hash").notNull(),
    quoteFingerprint: text("quote_fingerprint").notNull(),
    acceptedAt: instant("accepted_at").notNull(),
    cancelledAt: instant("cancelled_at"),
  },
  (t) => [
    check(
      "unlimited_auto_renewal_amount_check",
      sql`${t.amountValue} > 0 and ${t.amountExponent} >= 0 and ${t.currency} ~ '^[A-Z]{3}$'`
    ),
    check(
      "unlimited_auto_renewal_evidence_check",
      sql`${t.termsHash} ~ '^[0-9a-f]{64}$' and ${t.quoteFingerprint} ~ '^[0-9a-f]{64}$'`
    ),
  ]
);
