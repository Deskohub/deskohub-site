import "server-only";

import type { DotyposCustomerId } from "@deskohub/dotypos";
import { and, eq, isNull } from "drizzle-orm";
import { Effect } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { customerAccounts } from "@/db/schema";
import { getCoworkBookingPasses } from "@/features/cowork/cowork-entry-packs";
import { getWorkspaceDate } from "@/features/reservation/reservation-date";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import { getUnlimitedPassAccessDay } from "../unlimited-pass-period";
import { getUnlimitedDisplayStatus } from "./customer-pass-reads";
import { listHeldEntryPacks } from "./held-entry-packs";
import { listHeldUnlimitedPasses } from "./held-unlimited-passes";

/**
 * Whether the Dotypos customer's live account holds a pass that covers
 * their cowork visits at `asOf`: an Entry pack they can book with now (the
 * account page's bookable rule), or an Unlimited pass the account page
 * shows as active or upcoming. A customer without a live account holds no
 * pass.
 */
export const customerHoldsCoveringPass = Effect.fn("customerHoldsCoveringPass")(
  function* (dotyposCustomerId: DotyposCustomerId, asOf: Temporal.Instant) {
    const { db } = yield* WorkspaceDatabase;
    const [account] = yield* db
      .select({ id: customerAccounts.id })
      .from(customerAccounts)
      .where(
        and(
          eq(customerAccounts.dotyposCustomerId, dotyposCustomerId),
          isNull(customerAccounts.deletedAt)
        )
      )
      .limit(1);
    if (account === undefined) return false;

    const today = plainDateStringSchema.make(getWorkspaceDate(asOf).toString());
    const [packs, unlimitedPasses] = yield* Effect.all(
      [listHeldEntryPacks(account.id), listHeldUnlimitedPasses(account.id)],
      { concurrency: "unbounded" }
    );
    if (getCoworkBookingPasses(packs, today).packs.length > 0) return true;
    return unlimitedPasses.some((pass) => {
      const issued =
        pass.paymentState === "paid" || pass.paymentState === "complimentary";
      const accessDay = getUnlimitedPassAccessDay({ ...pass, date: today });
      const status = getUnlimitedDisplayStatus(pass, today, issued, accessDay);
      return status === "active" || status === "upcoming";
    });
  }
);
