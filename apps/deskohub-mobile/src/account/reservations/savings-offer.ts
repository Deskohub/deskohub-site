import type {
  CustomerPassList,
  CustomerReservationOrderId,
} from "@deskohub/workspace-customer-api";
import { Option } from "effect";
import {
  type ReservationListRow,
  reservationStatusTarget,
} from "./reservation-list-model";

/** A pass the account holds, as GET /passes lists it. */
type HeldPass = CustomerPassList["held"][number];

/** What decides whether the Past group offers packs and passes. */
export interface SavingsOfferFacts {
  /** The Past group's rows, read fresh from the Workspace. */
  readonly past: ReadonlyArray<ReservationListRow>;
  /**
   * The passes the account holds; undefined while the pass rollout is closed
   * or the read hasn't succeeded.
   */
  readonly held: ReadonlyArray<HeldPass> | undefined;
  /**
   * The orders an Entry pack paid for; undefined until that read succeeds.
   */
  readonly entryPackFunded: ReadonlySet<CustomerReservationOrderId> | undefined;
}

/**
 * Whether a pass still covers the account's next visits: an Entry pack
 * while it can book (the Workspace gives a usable pack, its gift claimed
 * and paid, a first date to book from), an Unlimited pass until it ends.
 */
const covers = (pass: HeldPass): boolean =>
  pass.kind === "entry-pack"
    ? pass.status === "active" &&
      pass.entriesLeft > 0 &&
      pass.bookFrom !== undefined
    : pass.status === "active" || pass.status === "upcoming";

/**
 * A paid coworking visit of the account's own: confirmed, not one it booked
 * for someone else (one booked for it by another account counts), and not
 * paid with an Entry pack. A row without an order is Dotypos-only, which
 * shows nothing about how it was paid.
 */
const paidIndividually = (
  row: ReservationListRow,
  entryPackFunded: ReadonlySet<CustomerReservationOrderId>
): boolean =>
  row.product.kind === "cowork" &&
  row.status === "confirmed" &&
  row.party?.kind !== "booked-for" &&
  Option.exists(
    reservationStatusTarget(row),
    (orderId) => !entryPackFunded.has(orderId)
  );

/**
 * Whether the Past group ends with the packs and passes offer (board 06): a
 * coworking visit paid individually, and no pass covering the next ones.
 * The same rule as the site's past reservations, as far as the app's data
 * reaches: fully discounted orders read as paid here.
 */
export const showsSavingsOffer = ({
  past,
  held,
  entryPackFunded,
}: SavingsOfferFacts): boolean =>
  held !== undefined &&
  entryPackFunded !== undefined &&
  !held.some(covers) &&
  past.some((row) => paidIndividually(row, entryPackFunded));
