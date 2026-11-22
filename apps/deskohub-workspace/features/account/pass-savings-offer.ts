import type { AccountPasses } from "./account-passes.server";
import type { AccountUnlimitedPasses } from "./account-unlimited-passes.server";
import type { CustomerReservationSummary } from "./contracts";

/**
 * A completed coworking visit the customer booked and paid for itself, one
 * visit at a time: confirmed, past, its own (no other party), and paid as a
 * single order rather than from an Entry pack or an Unlimited pass.
 */
const isPaidOwnCoworkVisit = (reservation: CustomerReservationSummary) =>
  reservation.product.kind === "cowork" &&
  reservation.status === "confirmed" &&
  reservation.party === undefined &&
  reservation.paidIndividually === true;

/**
 * Whether the Past reservations section offers Entry packs and Unlimited
 * passes: after a completed visit the customer paid for on its own, while it
 * holds no Entry pack with entries to use and no active or upcoming Unlimited
 * pass. Coverage that couldn't be read keeps the offer hidden.
 *
 * `past` is the history's past group, whose rows already ended or were
 * cancelled.
 */
export const offersPassSavings = ({
  past,
  entryPacks,
  unlimitedPasses,
}: {
  readonly past: readonly CustomerReservationSummary[];
  readonly entryPacks: AccountPasses;
  readonly unlimitedPasses: AccountUnlimitedPasses;
}): boolean =>
  entryPacks !== "unavailable" &&
  unlimitedPasses !== "unavailable" &&
  past.some(isPaidOwnCoworkVisit) &&
  !entryPacks.held.some(
    (pack) => pack.status === "active" && pack.entriesLeft > 0
  ) &&
  !unlimitedPasses.some(
    (pass) => pass.status === "active" || pass.status === "upcoming"
  );
