import "server-only";

import type { DotyposCustomerId } from "@deskohub/dotypos";
import { and, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import type { WorkspaceDatabaseClient } from "@/db/database.service";
import { emailCampaignAutomationCustomerClaims } from "@/db/schema";
import type { CampaignId } from "../../campaign-identifiers";

/**
 * The customers among `customers` whom a run of the campaign has claimed
 * for its once-per-customer send.
 */
export const claimedCampaignCustomers = (
  db: Pick<WorkspaceDatabaseClient, "select">,
  campaignId: CampaignId,
  customers: readonly DotyposCustomerId[]
) =>
  db
    .select({
      dotyposCustomerId:
        emailCampaignAutomationCustomerClaims.dotyposCustomerId,
    })
    .from(emailCampaignAutomationCustomerClaims)
    .where(
      and(
        eq(emailCampaignAutomationCustomerClaims.campaignId, campaignId),
        inArray(emailCampaignAutomationCustomerClaims.dotyposCustomerId, [
          ...customers,
        ])
      )
    )
    .pipe(
      Effect.map(
        (rows): ReadonlySet<DotyposCustomerId> =>
          new Set(rows.map((row) => row.dotyposCustomerId))
      )
    );
