// PROTOTYPE ONLY (#1392, screen 05 redo): mock passes and scenarios for using
// a pass inside the normal cowork booking step. Synthetic data; nothing here
// reads real passes or reserves anything.

import { PROTOTYPE_TODAY, type PassTierKey } from "../mock-passes";

export type BookingPass =
  | {
      readonly id: string;
      readonly product: "entry-pack";
      readonly tier: PassTierKey;
      readonly size: 5 | 10;
      readonly entriesLeft: number;
      readonly validUntil: string;
      /** Dates this holder already booked with any of their packs. */
      readonly bookedDates: readonly string[];
    }
  | {
      readonly id: string;
      readonly product: "unlimited";
      readonly tier: PassTierKey;
      readonly startDate: string;
      readonly endDate: string;
    };

export type EntryPack = Extract<BookingPass, { product: "entry-pack" }>;
export type UnlimitedPass = Extract<BookingPass, { product: "unlimited" }>;

const openSpacePack: EntryPack = {
  id: "EP-7Q2K",
  product: "entry-pack",
  tier: "open-space",
  size: 10,
  entriesLeft: 3,
  validUntil: "2027-02-15",
  bookedDates: ["2026-11-19"],
};

const reservedDeskPack: EntryPack = {
  id: "EP-4M8D",
  product: "entry-pack",
  tier: "reserved-desk",
  size: 5,
  entriesLeft: 4,
  validUntil: "2027-01-08",
  bookedDates: [],
};

const workstationPack: EntryPack = {
  id: "EP-9W3S",
  product: "entry-pack",
  tier: "workstation",
  size: 5,
  entriesLeft: 4,
  validUntil: "2027-01-20",
  bookedDates: [],
};

const expiringPack: EntryPack = {
  id: "EP-2X5E",
  product: "entry-pack",
  tier: "open-space",
  size: 5,
  entriesLeft: 2,
  validUntil: "2026-11-30",
  bookedDates: [],
};

const usedUpPack: EntryPack = {
  id: "EP-6U1P",
  product: "entry-pack",
  tier: "open-space",
  size: 5,
  entriesLeft: 0,
  validUntil: "2027-01-31",
  bookedDates: ["2026-11-19"],
};

const unlimitedPass: UnlimitedPass = {
  id: "UP-3K7A",
  product: "unlimited",
  tier: "open-space",
  startDate: "2026-11-05",
  endDate: "2026-12-04",
};

export type BookingTier = "open-space" | "reserved-desk";

export type BookingScenario = {
  readonly key: string;
  readonly label: string;
  readonly passes: readonly BookingPass[];
  readonly tier: BookingTier;
  readonly date: string;
  readonly coffee?: boolean;
  readonly appliedPassId?: string;
  /** ?pass= pointed at a pass this account can't use. */
  readonly invalidLink?: boolean;
  /** The selected date has only workstation desks free. */
  readonly onlyWorkstationFree?: boolean;
  /** Applied pass was spent elsewhere after the page loaded. */
  readonly spentElsewhere?: boolean;
  readonly step?: "choose" | "pay";
};

export const BOOKING_SCENARIOS: readonly BookingScenario[] = [
  {
    key: "none",
    label: "No pass",
    passes: [],
    tier: "open-space",
    date: "2026-11-18",
  },
  {
    key: "offer",
    label: "Offer",
    passes: [openSpacePack],
    tier: "open-space",
    date: "2026-11-18",
  },
  {
    key: "applied-open-space",
    label: "Applied · Open Space",
    passes: [openSpacePack],
    tier: "open-space",
    date: "2026-11-18",
    coffee: true,
    appliedPassId: openSpacePack.id,
  },
  {
    key: "applied-workstation",
    label: "Applied · workstation",
    passes: [workstationPack],
    tier: "reserved-desk",
    date: "2026-11-18",
    appliedPassId: workstationPack.id,
  },
  {
    key: "applied-desk-workstation-only",
    label: "Desk pack · only workstations free",
    passes: [reservedDeskPack],
    tier: "reserved-desk",
    date: "2026-11-20",
    appliedPassId: reservedDeskPack.id,
    onlyWorkstationFree: true,
  },
  {
    key: "covered",
    label: "Unlimited covers today",
    passes: [unlimitedPass],
    tier: "open-space",
    date: PROTOTYPE_TODAY,
  },
  {
    key: "not-usable-expired",
    label: "Not usable · after expiry",
    passes: [expiringPack],
    tier: "open-space",
    date: "2026-12-03",
  },
  {
    key: "not-usable-spent",
    label: "Not usable · spent elsewhere",
    passes: [usedUpPack],
    tier: "open-space",
    date: "2026-11-18",
    appliedPassId: usedUpPack.id,
    spentElsewhere: true,
  },
  {
    key: "multiple",
    label: "Two packs",
    passes: [openSpacePack, reservedDeskPack],
    tier: "open-space",
    date: "2026-11-18",
  },
  {
    key: "invalid-link",
    label: "Invalid ?pass link",
    passes: [],
    tier: "open-space",
    date: "2026-11-18",
    invalidLink: true,
  },
  {
    key: "pay-coffee",
    label: "Pay step · coffee only",
    passes: [openSpacePack],
    tier: "open-space",
    date: "2026-11-18",
    coffee: true,
    appliedPassId: openSpacePack.id,
    step: "pay",
  },
];

export const bookingScenario = (key: string) =>
  BOOKING_SCENARIOS.find((scenario) => scenario.key === key) ??
  BOOKING_SCENARIOS[0];

/** The step's tier card a pass locks; workstation packs lock Reserved Desk. */
export const lockedTier = (pass: {
  readonly tier: PassTierKey;
}): BookingTier =>
  pass.tier === "open-space" ? "open-space" : "reserved-desk";

export const packCoversDate = (pass: EntryPack, date: string) =>
  pass.entriesLeft > 0 &&
  date >= PROTOTYPE_TODAY &&
  date <= pass.validUntil &&
  !pass.bookedDates.includes(date);

export const unlimitedCovers = (pass: UnlimitedPass, date: string) =>
  date >= pass.startDate && date <= pass.endDate;

/** Default pick: soonest-expiring pack of the selected tier, else soonest. */
export const defaultPack = (packs: readonly EntryPack[], tier: BookingTier) => {
  const byExpiry = [...packs].sort((a, b) =>
    a.validUntil.localeCompare(b.validUntil)
  );
  return byExpiry.find((pack) => lockedTier(pack) === tier) ?? byExpiry[0];
};

export const unlimitedDay = (pass: UnlimitedPass, date: string) =>
  Math.round(
    (Date.parse(`${date}T00:00:00Z`) -
      Date.parse(`${pass.startDate}T00:00:00Z`)) /
      86_400_000
  ) + 1;

export const weekdayDate = (isoDate: string) =>
  new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${isoDate}T00:00:00Z`));
