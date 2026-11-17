// PROTOTYPE ONLY: extra mock data for the pass purchase screens (#1360).
// Synthetic people only. Nothing here persists or reaches a backend.

import {
  addDays,
  ENTRY_PACK_PRICES,
  ENTRY_PACK_VALIDITY_MONTHS,
  type EntryPackSize,
  PROTOTYPE_CUSTOMERS,
  PROTOTYPE_TODAY,
  type PassTierKey,
  UNLIMITED_DAYS,
} from "../mock-passes";

export const PROTOTYPE_BUYER = PROTOTYPE_CUSTOMERS.jana;
export const PROTOTYPE_OTHER_HOLDER = PROTOTYPE_CUSTOMERS.petr;

/** A discount code the prototype accepts: 10% off the pass price. */
export const PROTOTYPE_DISCOUNT_CODE = { code: "REGULAR10", percent: 10 };

/** The buyer's Dotypos customer discount group, applied without a code. */
export const PROTOTYPE_CUSTOMER_GROUP = { name: "Regulars", percent: 10 };

export const discounted = (price: number, percent: number) =>
  Math.round((price * (100 - percent)) / 100);

/** GUESS: validity runs from the purchase date to the same day N months on. */
export const entryPackValidUntil = (size: EntryPackSize) => {
  const date = new Date(`${PROTOTYPE_TODAY}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + ENTRY_PACK_VALIDITY_MONTHS[size]);
  return date.toISOString().slice(0, 10);
};

export const ENTRY_PACK_SIZES: readonly EntryPackSize[] = [5, 10];

export const lowestEntryPackDayPrice = (tier: PassTierKey) =>
  Math.round(ENTRY_PACK_PRICES[tier][10] / 10);

// ---------------------------------------------------------------------------
// Unlimited availability

/**
 * Dates on which the tier has no room for one more 30-day holder. For the
 * Reserved Desk tiers this is "no single desk free on every day".
 */
const UNLIMITED_FULL_DATES: Record<PassTierKey, readonly string[]> = {
  "open-space": ["2027-01-29"],
  "reserved-desk": ["2027-01-16"],
  workstation: ["2027-01-16"],
};

export const UNLIMITED_DEFAULT_START = addDays(PROTOTYPE_TODAY, 1);

export const unlimitedEnd = (start: string) =>
  addDays(start, UNLIMITED_DAYS - 1);

/** The full date inside the 30 days that stops this start, if any. */
export const unlimitedStartBlockedBy = (tier: PassTierKey, start: string) =>
  UNLIMITED_FULL_DATES[tier].find(
    (full) => full >= start && full <= unlimitedEnd(start)
  );

/** The first start date the full date blocks. */
export const unlimitedFirstBlockedStart = (tier: PassTierKey) => {
  const full = UNLIMITED_FULL_DATES[tier][0];
  return full ? addDays(full, -(UNLIMITED_DAYS - 1)) : undefined;
};

export const unlimitedFullDate = (tier: PassTierKey) =>
  UNLIMITED_FULL_DATES[tier][0];

/** The desk the 30 days would hold for a Reserved Desk start. */
export const PROTOTYPE_DESK = "Desk 07";

/** A monitor setup that is not free on all 30 days of the default start. */
export const UNLIMITED_UNAVAILABLE_MONITOR = "32-4k";

export const isoToLocalDate = (isoDate: string) => {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(year ?? 2026, (month ?? 1) - 1, day ?? 1);
};

export const localDateToIso = (date: Date) =>
  [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");

export const formatShortDate = (isoDate: string) =>
  new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${isoDate}T00:00:00Z`));
