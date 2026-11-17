// PROTOTYPE ONLY: in-memory mock data for the Entry pack / Unlimited screen
// prototypes (#1360, #1361, #1362). Synthetic people and example.com emails only.
// Prices are the owner-confirmed table from map #1353. Nothing here persists.

export const PROTOTYPE_TODAY = "2026-11-17";

export type PassTierKey = "open-space" | "reserved-desk" | "workstation";

export type PassTier = {
  key: PassTierKey;
  label: string;
  description: string;
  /** Today's single-day price, for the per-entry comparison. */
  singleDayPrice: number;
};

export const PASS_TIERS: readonly PassTier[] = [
  {
    key: "open-space",
    label: "Open Space",
    description: "Any free desk in the shared open space.",
    singleDayPrice: 290,
  },
  {
    key: "reserved-desk",
    label: "Reserved Desk",
    description: "Your own desk, held for you all day.",
    singleDayPrice: 410,
  },
  {
    key: "workstation",
    label: "Reserved Desk + workstation",
    // GUESS: day baseline = Reserved Desk 410 + workstation add-on 120.
    description: "Your own desk with two monitors set up for you.",
    singleDayPrice: 530,
  },
];

export type EntryPackSize = 5 | 10;

export const ENTRY_PACK_VALIDITY_MONTHS: Record<EntryPackSize, number> = {
  5: 2,
  10: 3,
};

export const ENTRY_PACK_PRICES: Record<
  PassTierKey,
  Record<EntryPackSize, number>
> = {
  "open-space": { 5: 1150, 10: 2190 },
  "reserved-desk": { 5: 1590, 10: 3090 },
  workstation: { 5: 2050, 10: 3990 },
};

export const UNLIMITED_DAYS = 30;

export const UNLIMITED_PRICES: Record<PassTierKey, number> = {
  "open-space": 3490,
  "reserved-desk": 5990,
  workstation: 8490,
};

export const UNLIMITED_COFFEE_PRICE = 690;
export const SINGLE_DAY_COFFEE_PRICE = 50; // catalog Open Space coffee add-on
export const WORKSTATION_ADDON_PRICE = 120;

export const MONITOR_OPTIONS = [
  { key: "27-qhd", label: "2× 27″ QHD" },
  { key: "32-qhd", label: "2× 32″ QHD" },
  { key: "27-4k", label: "2× 27″ 4K" },
  { key: "32-4k", label: "2× 32″ 4K" },
] as const;

export const entryPackPricePerEntry = (tier: PassTierKey, size: EntryPackSize) =>
  Math.round(ENTRY_PACK_PRICES[tier][size] / size);

export const entryPackSavingPerEntry = (tier: PassTierKey, size: EntryPackSize) =>
  tierByKey(tier).singleDayPrice - entryPackPricePerEntry(tier, size);

export const tierByKey = (key: PassTierKey): PassTier =>
  PASS_TIERS.find((tier) => tier.key === key) ?? (PASS_TIERS[0] as PassTier);

/** Owner-confirmed (#1354): round down to whole CZK. */
export const unlimitedRefund = (paid: number, elapsedDaysIncludingToday: number) =>
  Math.floor((paid * (UNLIMITED_DAYS - elapsedDaysIncludingToday)) / UNLIMITED_DAYS);

export const entryPackRefund = (paid: number, unused: number, total: number) =>
  Math.floor((paid * unused) / total);

export const formatCzk = (amount: number) =>
  `CZK ${new Intl.NumberFormat("en-US").format(amount)}`;

export const formatPrototypeDate = (isoDate: string) =>
  new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${isoDate}T00:00:00Z`));

export const addDays = (isoDate: string, days: number) => {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

// ---------------------------------------------------------------------------
// People (synthetic)

export type PrototypeCustomer = {
  id: string;
  name: string;
  email: string;
};

export const PROTOTYPE_CUSTOMERS = {
  jana: { id: "cus_1001", name: "Jana Dvořáková", email: "jana.dvorakova@example.com" },
  petr: { id: "cus_1002", name: "Petr Svoboda", email: "petr.svoboda@example.com" },
  lucie: { id: "cus_1003", name: "Lucie Horáková", email: "lucie.horakova@example.com" },
  martin: { id: "cus_1004", name: "Martin Kučera", email: "martin.kucera@example.com" },
  eva: { id: "cus_1005", name: "Eva Marková", email: "eva.markova@example.com" },
  studio: { id: "cus_1006", name: "Atelier Nord s.r.o.", email: "office@atelier-nord.example.com" },
} as const satisfies Record<string, PrototypeCustomer>;

// ---------------------------------------------------------------------------
// Passes

export type PassStatus =
  | "scheduled" // Unlimited bought, start date in future
  | "active"
  | "used-up"
  | "expired"
  | "cancelled";

export type PassUsageEntry = {
  date: string;
  kind: "entry-booked" | "entry-used" | "entry-released" | "day-reserved" | "day-used" | "day-released";
  note?: string;
  addonsPaid?: number;
};

export type PassAuditEvent = {
  at: string; // ISO datetime
  actor: string;
  action: "purchased" | "granted" | "holder-invited" | "holder-reassigned" | "extended" | "cancelled" | "refund-marked";
  detail: string;
};

type PassBase = {
  id: string;
  tier: PassTierKey;
  status: PassStatus;
  buyer: PrototypeCustomer | null; // null = complimentary grant
  holder: PrototypeCustomer;
  holderVerified: boolean;
  paid: number; // 0 for complimentary
  discountLabel?: string;
  coffee?: boolean;
  purchasedAt: string;
  usage: PassUsageEntry[];
  audit: PassAuditEvent[];
};

export type EntryPackPass = PassBase & {
  product: "entry-pack";
  size: EntryPackSize;
  entriesUsed: number;
  entriesBooked: number; // future dates claimed
  validFrom: string;
  validUntil: string;
};

export type UnlimitedPass = PassBase & {
  product: "unlimited";
  startDate: string;
  endDate: string;
  deskLabel?: string; // Reserved Desk tiers keep one desk
  monitorOption?: (typeof MONITOR_OPTIONS)[number]["key"];
};

export type PrototypePass = EntryPackPass | UnlimitedPass;

const { jana, petr, lucie, martin, eva, studio } = PROTOTYPE_CUSTOMERS;

export const PROTOTYPE_PASSES: PrototypePass[] = [
  {
    id: "pass_7Q2K",
    product: "entry-pack",
    tier: "open-space",
    size: 10,
    status: "active",
    buyer: jana,
    holder: jana,
    holderVerified: true,
    paid: 2190,
    purchasedAt: "2026-10-02T09:14:00Z",
    validFrom: "2026-10-02",
    validUntil: "2027-01-01",
    entriesUsed: 6,
    entriesBooked: 1,
    usage: [
      { date: "2026-10-06", kind: "entry-used" },
      { date: "2026-10-13", kind: "entry-used", addonsPaid: 50, note: "Coffee" },
      { date: "2026-10-20", kind: "entry-used" },
      { date: "2026-10-27", kind: "entry-used" },
      { date: "2026-11-03", kind: "entry-used", addonsPaid: 50, note: "Coffee" },
      { date: "2026-11-10", kind: "entry-used" },
      { date: "2026-11-19", kind: "entry-booked" },
    ],
    audit: [
      { at: "2026-10-02T09:14:00Z", actor: "Jana Dvořáková", action: "purchased", detail: "Paid CZK 2,190 by card (Nexi)" },
    ],
  },
  {
    id: "pass_9HX3",
    product: "unlimited",
    tier: "reserved-desk",
    status: "active",
    buyer: petr,
    holder: petr,
    holderVerified: true,
    paid: 6680,
    coffee: true,
    purchasedAt: "2026-11-01T18:40:00Z",
    startDate: "2026-11-03",
    endDate: "2026-12-02",
    deskLabel: "Desk 14",
    usage: [
      { date: "2026-11-03", kind: "day-used" },
      { date: "2026-11-04", kind: "day-used" },
      { date: "2026-11-17", kind: "day-reserved", note: "Today — code issued 08:02" },
    ],
    audit: [
      { at: "2026-11-01T18:40:00Z", actor: "Petr Svoboda", action: "purchased", detail: "Paid CZK 6,680 incl. coffee CZK 690 (Nexi)" },
    ],
  },
  {
    id: "pass_4MZT",
    product: "entry-pack",
    tier: "reserved-desk",
    size: 5,
    status: "active",
    buyer: martin,
    holder: lucie,
    holderVerified: false,
    paid: 1590,
    purchasedAt: "2026-11-15T12:05:00Z",
    validFrom: "2026-11-15",
    validUntil: "2027-01-14",
    entriesUsed: 0,
    entriesBooked: 0,
    usage: [],
    audit: [
      { at: "2026-11-15T12:05:00Z", actor: "Martin Kučera", action: "purchased", detail: "Paid CZK 1,590 by card (Nexi)" },
      { at: "2026-11-15T12:05:03Z", actor: "System", action: "holder-invited", detail: "Invitation sent to lucie.horakova@example.com" },
    ],
  },
  {
    id: "pass_2BWD",
    product: "unlimited",
    tier: "workstation",
    status: "scheduled",
    buyer: studio,
    holder: eva,
    holderVerified: true,
    paid: 7641,
    discountLabel: "Company group −10%",
    purchasedAt: "2026-11-12T08:30:00Z",
    startDate: "2026-12-01",
    endDate: "2026-12-30",
    deskLabel: "Desk 3",
    monitorOption: "27-4k",
    usage: [],
    audit: [
      { at: "2026-11-12T08:30:00Z", actor: "Atelier Nord s.r.o.", action: "purchased", detail: "Paid CZK 7,641 (CZK 8,490 − 10% group discount)" },
    ],
  },
  {
    id: "pass_6RFA",
    product: "unlimited",
    tier: "open-space",
    status: "active",
    buyer: null,
    holder: jana,
    holderVerified: true,
    paid: 0,
    purchasedAt: "2026-11-10T10:00:00Z",
    startDate: "2026-11-10",
    endDate: "2026-12-09",
    usage: [
      { date: "2026-11-10", kind: "day-used" },
      { date: "2026-11-11", kind: "day-used" },
    ],
    audit: [
      { at: "2026-11-10T10:00:00Z", actor: "admin@example.com", action: "granted", detail: "Complimentary — community event host" },
    ],
  },
  {
    id: "pass_1CEN",
    product: "entry-pack",
    tier: "workstation",
    size: 10,
    status: "expired",
    buyer: martin,
    holder: martin,
    holderVerified: true,
    paid: 3990,
    purchasedAt: "2026-07-01T07:50:00Z",
    validFrom: "2026-07-01",
    validUntil: "2026-09-30",
    entriesUsed: 8,
    entriesBooked: 0,
    usage: [],
    audit: [
      { at: "2026-07-01T07:50:00Z", actor: "Martin Kučera", action: "purchased", detail: "Paid CZK 3,990 by card (Nexi)" },
      { at: "2026-09-23T06:00:00Z", actor: "System", action: "extended", detail: "Expiry reminder sent (7 days, 2 entries left)" },
    ],
  },
  {
    id: "pass_8TLS",
    product: "entry-pack",
    tier: "open-space",
    size: 5,
    status: "cancelled",
    buyer: eva,
    holder: eva,
    holderVerified: true,
    paid: 1150,
    purchasedAt: "2026-10-20T15:22:00Z",
    validFrom: "2026-10-20",
    validUntil: "2026-12-19",
    entriesUsed: 1,
    entriesBooked: 0,
    usage: [{ date: "2026-10-22", kind: "entry-used" }],
    audit: [
      { at: "2026-10-20T15:22:00Z", actor: "Eva Marková", action: "purchased", detail: "Paid CZK 1,150 by card (Nexi)" },
      { at: "2026-10-24T11:10:00Z", actor: "admin@example.com", action: "cancelled", detail: "Withdrawal within 14 days — 4 of 5 entries unused" },
      { at: "2026-10-24T11:10:00Z", actor: "admin@example.com", action: "refund-marked", detail: "Refund CZK 920 to process in Nexi back office" },
    ],
  },
];

export const passById = (id: string) =>
  PROTOTYPE_PASSES.find((pass) => pass.id === id);

export const passesForHolder = (customerId: string) =>
  PROTOTYPE_PASSES.filter((pass) => pass.holder.id === customerId);

export const unlimitedElapsedDays = (pass: UnlimitedPass, today = PROTOTYPE_TODAY) => {
  if (today < pass.startDate) return 0;
  const ms =
    new Date(`${today}T00:00:00Z`).getTime() -
    new Date(`${pass.startDate}T00:00:00Z`).getTime();
  return Math.min(UNLIMITED_DAYS, Math.floor(ms / 86_400_000) + 1);
};

export const productLabel = (pass: PrototypePass) =>
  pass.product === "entry-pack" ? `Entry pack · ${pass.size} entries` : "Unlimited · 30 days";
