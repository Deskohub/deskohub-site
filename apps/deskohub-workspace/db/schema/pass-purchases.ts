import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
} from "drizzle-orm/pg-core";
import type { CustomerAccountId } from "@/features/account/customer-account";
import type { Locale } from "@/features/i18n";
import type { OrderId } from "@/features/order";
import type { entryPackPurchaseQuoteCodec } from "@/features/passes/entry-pack-purchase-quote";
import { type PassStatus, passStatuses } from "@/features/passes/pass";
import {
  type EntryPackSize,
  type PassTier,
  passTiers,
} from "@/features/passes/pass-offer";
import type { PlainDate } from "@/shared/utils/temporal";
import { instant } from "../instant";
import { customerAccounts } from "./customer-accounts";
import { orders } from "./orders";
import { quotedSqlList } from "./sql-list";

export const passPurchases = pgTable(
  "pass_purchases",
  {
    id: text("id")
      .primaryKey()
      .$type<OrderId>()
      .references(() => orders.id),
    buyerAccountId: text("buyer_account_id")
      .notNull()
      .$type<CustomerAccountId>()
      .references(() => customerAccounts.id),
    holderAccountId: text("holder_account_id")
      .notNull()
      .$type<CustomerAccountId>()
      .references(() => customerAccounts.id),
    product: text("product").notNull().$type<"entry-pack">(),
    tier: text("tier").notNull().$type<PassTier>(),
    entryCount: integer("entry_count").notNull().$type<EntryPackSize>(),
    status: text("status").notNull().$type<PassStatus>(),
    validFrom: date("valid_from", { mode: "string" })
      .notNull()
      .$type<PlainDate>(),
    validUntil: date("valid_until", { mode: "string" })
      .notNull()
      .$type<PlainDate>(),
    quote: jsonb("quote")
      .notNull()
      .$type<typeof entryPackPurchaseQuoteCodec.Encoded>(),
    locale: text("locale").notNull().$type<Locale>(),
    createdAt: instant("created_at").notNull(),
    giftIssuedAt: instant("gift_issued_at"),
    giftClaimedAt: instant("gift_claimed_at"),
  },
  (t) => [
    check("pass_purchases_product_check", sql`${t.product} = 'entry-pack'`),
    check(
      "pass_purchases_tier_check",
      sql`${t.tier} in (${quotedSqlList(passTiers)})`
    ),
    check("pass_purchases_entry_count_check", sql`${t.entryCount} in (5, 10)`),
    check(
      "pass_purchases_status_check",
      sql`${t.status} in (${quotedSqlList(passStatuses)})`
    ),
    check(
      "pass_purchases_validity_check",
      sql`${t.validFrom} < ${t.validUntil}`
    ),
    check(
      "pass_purchases_gift_claim_check",
      sql`(${t.giftIssuedAt} is null and ${t.giftClaimedAt} is null) or ${t.holderAccountId} <> ${t.buyerAccountId}`
    ),
    index("pass_purchases_buyer_idx").on(t.buyerAccountId),
    index("pass_purchases_holder_idx").on(t.holderAccountId),
  ]
);
