import type {
  CustomerBookingSelection,
  CustomerHeldEntryPack,
  CustomerPassTier,
} from "@deskohub/workspace-customer-api";
import { Option } from "effect";
import type { DateChoice } from "../booking/selection/booking-selection";
import {
  type CoworkDraft,
  selectCoworkTier,
} from "../booking/selection/cowork-selection";
import type { PragueDate } from "../booking/selection/prague-date";

export const coworkPassTier = (draft: CoworkDraft): CustomerPassTier =>
  draft.tier === "reserved-desk" && Option.isSome(draft.workstation)
    ? "reserved-desk-workstation"
    : draft.tier;

export const packCoversDraft = (
  pack: CustomerHeldEntryPack,
  draft: CoworkDraft
) => pack.tier === coworkPassTier(draft);

// A pack opened from Account chooses the desk type, then lets the customer
// choose a date and, for workstation packs, an available monitor.
export const openEntryPackDraft = (
  draft: CoworkDraft,
  pack: CustomerHeldEntryPack
): CoworkDraft => ({
  ...selectCoworkTier(
    draft,
    pack.tier === "open-space" ? "open-space" : "reserved-desk"
  ),
  date: Option.none(),
  stay: "day",
  coffee: false,
  workstation: Option.none(),
});

export const entryPackDates = (
  dates: DateChoice,
  pack: CustomerHeldEntryPack,
  claimedDates: ReadonlyArray<PragueDate>
): DateChoice => ({
  earliest: dates.earliest < pack.validFrom ? pack.validFrom : dates.earliest,
  latest:
    dates.latest > pack.lastUsableDate ? pack.lastUsableDate : dates.latest,
  unavailable: new Set([...dates.unavailable, ...claimedDates]),
});

export const applyEntryPack = (draft: CoworkDraft): CoworkDraft =>
  draft.coffee ? { ...draft, coffee: false } : draft;

export const fundWithEntryPack = (
  selection: Option.Option<CustomerBookingSelection>,
  passId: string | undefined
) =>
  passId === undefined
    ? selection
    : Option.map(
        selection,
        (value): CustomerBookingSelection => ({
          ...value,
          funding: { kind: "entry", passId },
        })
      );
