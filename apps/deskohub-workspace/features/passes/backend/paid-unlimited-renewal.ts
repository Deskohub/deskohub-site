import { sql } from "drizzle-orm";
import { orders, passPurchases } from "@/db/schema";

/** Whether a paid renewal already uses the next period for the same holder. */
export const hasPaidUnlimitedRenewal = sql<boolean>`exists (
  select 1 from ${passPurchases} successor
  join ${orders} successor_order on successor_order.id = successor.id
  where successor.renews_pass_id = ${passPurchases.id}
    and successor.holder_account_id = ${passPurchases.holderAccountId}
    and successor.product = 'unlimited'
    and (successor.status in ('active', 'expired')
      or (successor.status in ('cancelled', 'withdrawn') and successor.access_ends_on > successor.valid_from))
    and (successor.buyer_account_id = successor.holder_account_id or successor.gift_claimed_at is not null)
    and successor.valid_from = ${passPurchases.validUntil}
    and successor_order.kind = 'pass-purchase'
    and successor_order.payment_state = 'paid'
    and successor_order.paid_at is not null
)`;
