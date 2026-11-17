// PROTOTYPE ONLY (#1361): the pass holder's view of the shared mock passes,
// plus a few local passes so every holder-screen state has an example.
// Synthetic people only. Nothing persists.

import {
  addDays,
  type EntryPackPass,
  formatPrototypeDate,
  PROTOTYPE_CUSTOMERS,
  PROTOTYPE_TODAY,
  type PrototypePass,
  passById,
  type UnlimitedPass,
  UNLIMITED_DAYS,
  unlimitedElapsedDays,
} from "@/features/passes/prototype/mock-passes";

const { jana, petr, lucie } = PROTOTYPE_CUSTOMERS;

const ownPack = passById("pass_7Q2K") as EntryPackPass;
const complimentaryUnlimited = passById("pass_6RFA") as UnlimitedPass;
/** Reserved Desk Unlimited, for the access page's Reserved Desk state. */
export const reservedDeskUnlimited = passById("pass_9HX3") as UnlimitedPass;

/** Gifted to Jana by Petr: shows "bought by". */
const giftedPack: EntryPackPass = {
  id: "pass_5GFT",
  product: "entry-pack",
  tier: "reserved-desk",
  size: 5,
  status: "active",
  buyer: petr,
  holder: jana,
  holderVerified: true,
  paid: 1590,
  purchasedAt: "2026-11-14T16:20:00Z",
  validFrom: "2026-11-14",
  validUntil: "2027-01-13",
  entriesUsed: 0,
  entriesBooked: 0,
  usage: [],
  audit: [],
};

/** Bought by Jana for Lucie, who has not signed in yet. */
const boughtForLucie: EntryPackPass = {
  id: "pass_3INV",
  product: "entry-pack",
  tier: "open-space",
  size: 5,
  status: "active",
  buyer: jana,
  holder: lucie,
  holderVerified: false,
  paid: 1150,
  purchasedAt: "2026-11-16T19:02:00Z",
  validFrom: "2026-11-16",
  validUntil: "2027-01-15",
  entriesUsed: 0,
  entriesBooked: 0,
  usage: [],
  audit: [],
};

/** Old pack that ran out of time with one entry unused. */
const expiredPack: EntryPackPass = {
  id: "pass_0EXP",
  product: "entry-pack",
  tier: "open-space",
  size: 5,
  status: "expired",
  buyer: jana,
  holder: jana,
  holderVerified: true,
  paid: 1150,
  purchasedAt: "2026-07-20T10:00:00Z",
  validFrom: "2026-07-20",
  validUntil: "2026-09-19",
  entriesUsed: 4,
  entriesBooked: 0,
  usage: [],
  audit: [],
};

/** Old pack with every entry used. */
const usedUpPack: EntryPackPass = {
  id: "pass_0USD",
  product: "entry-pack",
  tier: "open-space",
  size: 5,
  status: "used-up",
  buyer: jana,
  holder: jana,
  holderVerified: true,
  paid: 1150,
  purchasedAt: "2026-05-04T08:00:00Z",
  validFrom: "2026-05-04",
  validUntil: "2026-07-03",
  entriesUsed: 5,
  entriesBooked: 0,
  usage: [],
  audit: [],
};

export const HOLDER = jana;

export const HOLDER_PASSES = {
  active: [ownPack, complimentaryUnlimited, giftedPack],
  boughtForOthers: [boughtForLucie],
  past: [expiredPack, usedUpPack],
};

export const PACK_FOR_BOOKING = ownPack;

export const entriesLeft = (pass: EntryPackPass) =>
  pass.size - pass.entriesUsed - pass.entriesBooked;

export const unlimitedDaysLeft = (pass: UnlimitedPass) =>
  UNLIMITED_DAYS - unlimitedElapsedDays(pass) + (pass.startDate <= PROTOTYPE_TODAY ? 1 : 0);

export const unlimitedDayNumber = (pass: UnlimitedPass) =>
  unlimitedElapsedDays(pass);

export const formatPeriod = (from: string, to: string) =>
  `${formatPrototypeDate(from).replace(/ \d{4}$/, "")} – ${formatPrototypeDate(to)}`;

export const formatWeekdayDate = (isoDate: string) =>
  new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${isoDate}T00:00:00Z`));

export const daysUntil = (isoDate: string) =>
  Math.round(
    (new Date(`${isoDate}T00:00:00Z`).getTime() -
      new Date(`${PROTOTYPE_TODAY}T00:00:00Z`).getTime()) /
      86_400_000
  );

/** Today's mock door code per tier (synthetic, fixed). */
export const TODAY_DOOR_CODE = {
  "open-space": "418305927",
  "reserved-desk": "730152864",
} as const;

export const TOMORROW = addDays(PROTOTYPE_TODAY, 1);

export type HolderPass = PrototypePass;
