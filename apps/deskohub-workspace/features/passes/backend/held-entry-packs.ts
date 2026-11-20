import "server-only";

import { and, asc, eq, isNotNull, ne, sql } from "drizzle-orm";
import { Effect } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { orders, passEntryClaims, passPurchases } from "@/db/schema";
import type { CustomerAccountId } from "@/features/account/customer-account";
import type { OrderId } from "@/features/order";
import type { PlainDate } from "@/shared/utils/temporal";
import type { PassStatus } from "../pass";
import type { EntryPackSize, PassTier } from "../pass-offer";

export type HeldEntryPack = {
  readonly id: OrderId;
  readonly tier: PassTier;
  readonly entryCount: EntryPackSize;
  readonly entriesLeft: number;
  readonly paidAt: Temporal.Instant;
  readonly validFrom: PlainDate;
  readonly validUntil: PlainDate;
  readonly status: PassStatus;
  readonly claimedDates: readonly PlainDate[];
};

/** Payment and claim state from one snapshot, scoped to the verified holder. */
export const listHeldEntryPacks = Effect.fn("listHeldEntryPacks")(function* (
  accountId: CustomerAccountId
) {
  const { db } = yield* WorkspaceDatabase;
  const rows = yield* db
    .select({
      id: passPurchases.id,
      tier: passPurchases.tier,
      entryCount: passPurchases.entryCount,
      paidAt: orders.paidAt,
      validFrom: passPurchases.validFrom,
      validUntil: passPurchases.validUntil,
      status: passPurchases.status,
      claimedDates: sql<PlainDate[]>`coalesce(
        array_agg(${passEntryClaims.date}::text order by ${passEntryClaims.date})
          filter (where ${passEntryClaims.date} is not null),
        array[]::text[]
      )`,
    })
    .from(passPurchases)
    .innerJoin(orders, eq(orders.id, passPurchases.id))
    .leftJoin(
      passEntryClaims,
      and(
        eq(passEntryClaims.passId, passPurchases.id),
        ne(passEntryClaims.status, "released")
      )
    )
    .where(
      and(
        eq(passPurchases.holderAccountId, accountId),
        isNotNull(orders.paidAt),
        ne(passPurchases.status, "void")
      )
    )
    .groupBy(passPurchases.id, orders.paidAt)
    .orderBy(asc(passPurchases.validUntil), asc(passPurchases.id));

  return rows.flatMap(({ paidAt, ...pack }): HeldEntryPack[] =>
    paidAt
      ? [
          {
            ...pack,
            paidAt,
            entriesLeft: Math.max(0, pack.entryCount - pack.claimedDates.length),
          },
        ]
      : []
  );
});
