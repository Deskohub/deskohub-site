// PROTOTYPE ONLY: administration view of the shared pass mock data (#1362).
// Adds a few synthetic records and derived values the admin screens need.
// Nothing here persists; never import from production code.

import {
  addDays,
  ENTRY_PACK_PRICES,
  type EntryPackPass,
  entryPackRefund,
  formatCzk,
  formatPrototypeDate,
  PROTOTYPE_CUSTOMERS,
  PROTOTYPE_PASSES,
  PROTOTYPE_TODAY,
  type PassAuditEvent,
  type PassTierKey,
  type PrototypeCustomer,
  type PrototypePass,
  tierByKey,
  UNLIMITED_COFFEE_PRICE,
  UNLIMITED_DAYS,
  UNLIMITED_PRICES,
  type UnlimitedPass,
  unlimitedElapsedDays,
  unlimitedRefund,
} from "../mock-passes";

export const ADMIN_TODAY = PROTOTYPE_TODAY;
export const ADMIN_ACTOR = "admin@example.com";

const { jana, petr } = PROTOTYPE_CUSTOMERS;

/** A pass Jana bought for someone else, so her customer page shows both groups. */
const extraPasses: PrototypePass[] = [
  {
    id: "pass_5KJN",
    product: "entry-pack",
    tier: "open-space",
    size: 5,
    status: "active",
    buyer: jana,
    holder: petr,
    holderVerified: true,
    paid: 1150,
    purchasedAt: "2026-11-05T16:20:00Z",
    validFrom: "2026-11-05",
    validUntil: "2027-01-04",
    entriesUsed: 2,
    entriesBooked: 0,
    usage: [
      { date: "2026-11-09", kind: "entry-used" },
      { date: "2026-11-12", kind: "entry-used" },
    ],
    audit: [
      {
        at: "2026-11-05T16:20:00Z",
        actor: jana.name,
        action: "purchased",
        detail: "Paid CZK 1,150 by card (Nexi) · holder petr.svoboda@example.com",
      },
      {
        at: "2026-11-05T16:20:02Z",
        actor: "System",
        action: "holder-invited",
        detail: "Pass notice sent to petr.svoboda@example.com (existing account)",
      },
    ],
  },
];

/** Richer histories than the shared mock carries, to show every audit event. */
const overrides: Record<string, Partial<PrototypePass>> = {
  pass_7Q2K: {
    usage: [
      { date: "2026-10-06", kind: "entry-used" },
      { date: "2026-10-13", kind: "entry-used", addonsPaid: 50, note: "Coffee" },
      { date: "2026-10-20", kind: "entry-used" },
      { date: "2026-10-27", kind: "entry-used" },
      { date: "2026-11-03", kind: "entry-used", addonsPaid: 50, note: "Coffee" },
      { date: "2026-11-10", kind: "entry-used" },
      {
        date: "2026-11-14",
        kind: "entry-released",
        note: "Add-on payment failed, entry returned",
      },
      { date: "2026-11-19", kind: "entry-booked", addonsPaid: 50, note: "Coffee" },
    ],
    audit: [
      {
        at: "2026-10-02T09:14:00Z",
        actor: jana.name,
        action: "purchased",
        detail: "Paid CZK 2,190 by card (Nexi)",
      },
      {
        at: "2026-11-11T14:32:00Z",
        actor: ADMIN_ACTOR,
        action: "extended",
        detail: "Expiry 18 Dec 2026 → 1 Jan 2027 · Closed 21–31 Dec for holidays",
      },
    ],
  },
  pass_4MZT: {
    audit: [
      {
        at: "2026-11-15T12:05:00Z",
        actor: "Martin Kučera",
        action: "purchased",
        detail: "Paid CZK 1,590 by card (Nexi) · holder l.horakova@example.com",
      },
      {
        at: "2026-11-15T12:05:03Z",
        actor: "System",
        action: "holder-invited",
        detail: "Invitation sent to l.horakova@example.com (new account)",
      },
      {
        at: "2026-11-16T09:41:00Z",
        actor: ADMIN_ACTOR,
        action: "holder-reassigned",
        detail: "l.horakova@example.com → lucie.horakova@example.com · Buyer reported a typo",
      },
      {
        at: "2026-11-16T09:41:02Z",
        actor: "System",
        action: "holder-invited",
        detail: "Invitation sent to lucie.horakova@example.com (new account)",
      },
    ],
  },
  pass_1CEN: {
    audit: [
      {
        at: "2026-07-01T07:50:00Z",
        actor: "Martin Kučera",
        action: "purchased",
        detail: "Paid CZK 3,990 by card (Nexi)",
      },
    ],
  },
};

export const ADMIN_PASSES: PrototypePass[] = [
  ...PROTOTYPE_PASSES.map(
    (pass) => ({ ...pass, ...overrides[pass.id] }) as PrototypePass
  ),
  ...extraPasses,
].sort((a, b) => b.purchasedAt.localeCompare(a.purchasedAt));

export const adminPassById = (id: string) =>
  ADMIN_PASSES.find((pass) => pass.id === id);

export const adminCustomers: PrototypeCustomer[] = Object.values(PROTOTYPE_CUSTOMERS);

export const adminCustomerById = (id: string) =>
  adminCustomers.find((customer) => customer.id === id);

export const passesHeldBy = (customerId: string) =>
  ADMIN_PASSES.filter((pass) => pass.holder.id === customerId);

export const passesBoughtForOthersBy = (customerId: string) =>
  ADMIN_PASSES.filter(
    (pass) => pass.buyer?.id === customerId && pass.holder.id !== customerId
  );

// ---------------------------------------------------------------------------
// Presentation values

export const productName = (pass: PrototypePass) =>
  pass.product === "entry-pack" ? "Entry pack" : "Unlimited";

export const productSizeLabel = (pass: PrototypePass) =>
  pass.product === "entry-pack" ? `${pass.size} entries` : `${UNLIMITED_DAYS} days`;

export const tierLabel = (tier: PassTierKey) => tierByKey(tier).label;

export const isComplimentary = (pass: PrototypePass) => pass.buyer === null;

export const paidLabel = (pass: PrototypePass) =>
  isComplimentary(pass) ? "Complimentary" : formatCzk(pass.paid);

export const listPrice = (pass: PrototypePass) =>
  pass.product === "entry-pack"
    ? ENTRY_PACK_PRICES[pass.tier][pass.size]
    : UNLIMITED_PRICES[pass.tier] + (pass.coffee ? UNLIMITED_COFFEE_PRICE : 0);

export const validityStart = (pass: PrototypePass) =>
  pass.product === "entry-pack" ? pass.validFrom : pass.startDate;

export const validityEnd = (pass: PrototypePass) =>
  pass.product === "entry-pack" ? pass.validUntil : pass.endDate;

export const validityLabel = (pass: PrototypePass) =>
  `${formatShortDate(validityStart(pass))} – ${formatPrototypeDate(validityEnd(pass))}`;

/** "3 Nov" without the year, for ranges whose end carries it. */
export const formatShortDate = (isoDate: string) =>
  new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${isoDate}T00:00:00Z`));

export const formatWeekdayDate = (isoDate: string) =>
  new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${isoDate}T00:00:00Z`));

/** Prague date and 24-hour time without locale-specific spacing. */
export const formatAdminDateTime = (iso: string) => {
  const date = new Date(iso);
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Prague",
  }).format(date);
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    timeZone: "Europe/Prague",
  }).format(date);
  return `${formatPrototypeDate(day)}, ${time}`;
};

export type EntryPackCounts = {
  used: number;
  booked: number;
  free: number;
  total: number;
};

export const entryPackCounts = (pass: EntryPackPass): EntryPackCounts => ({
  used: pass.entriesUsed,
  booked: pass.entriesBooked,
  free: Math.max(0, pass.size - pass.entriesUsed - pass.entriesBooked),
  total: pass.size,
});

/** Remaining entries or days, as the list and customer tables show them. */
export const remainingLabel = (pass: PrototypePass) => {
  if (pass.product === "entry-pack") {
    const counts = entryPackCounts(pass);
    if (pass.status === "cancelled") return `${counts.used} of ${counts.total} used`;
    if (pass.status === "expired")
      return `${counts.free} of ${counts.total} unused`;
    return `${counts.free} of ${counts.total} free`;
  }
  const elapsed = unlimitedElapsedDays(pass);
  if (pass.status === "scheduled")
    return `Starts ${formatShortDate(pass.startDate)}`;
  if (pass.status !== "active") return `${elapsed} of ${UNLIMITED_DAYS} days`;
  return `Day ${elapsed} of ${UNLIMITED_DAYS}`;
};

export const remainingDetail = (pass: PrototypePass) => {
  if (pass.product === "entry-pack") {
    return pass.entriesBooked > 0 && pass.status === "active"
      ? `${pass.entriesBooked} booked ahead`
      : undefined;
  }
  if (pass.status === "active") {
    const left = UNLIMITED_DAYS - unlimitedElapsedDays(pass);
    return `${left} days after today`;
  }
  return undefined;
};

export type PassStatusPresentation = {
  label: string;
  tone: "attention" | "neutral" | "positive" | "progress";
};

export const passStatusPresentation = (
  pass: PrototypePass
): PassStatusPresentation =>
  ({
    active: { label: "Active", tone: "positive" },
    scheduled: { label: "Scheduled", tone: "progress" },
    "used-up": { label: "Used up", tone: "neutral" },
    expired: { label: "Expired", tone: "neutral" },
    cancelled: { label: "Cancelled", tone: "attention" },
  })[pass.status] as PassStatusPresentation;

// ---------------------------------------------------------------------------
// Rules the action dialogs show

/** GUESS: a pass counts as used once an entry is booked or Unlimited has started. */
export const firstUseDate = (pass: PrototypePass): string | undefined => {
  if (pass.product === "unlimited") {
    return ADMIN_TODAY >= pass.startDate ? pass.startDate : undefined;
  }
  const claimed = pass.usage
    .filter((entry) => entry.kind === "entry-used" || entry.kind === "entry-booked")
    .map((entry) => entry.date)
    .sort();
  return claimed[0];
};

export type RefundQuote = {
  paid: number;
  refund: number;
  /** "4 of 10 entries unused" or "15 of 30 days left". */
  basis: string;
  formula: string;
  releasedDates: string[];
  todayStaysValid: boolean;
};

export const refundQuote = (pass: PrototypePass): RefundQuote => {
  if (pass.product === "entry-pack") {
    const usedIncludingToday =
      pass.entriesUsed +
      (pass.usage.some(
        (entry) => entry.kind === "entry-booked" && entry.date === ADMIN_TODAY
      )
        ? 1
        : 0);
    const unused = pass.size - usedIncludingToday;
    const releasedDates = pass.usage
      .filter((entry) => entry.kind === "entry-booked" && entry.date > ADMIN_TODAY)
      .map((entry) => entry.date);
    return {
      paid: pass.paid,
      refund: entryPackRefund(pass.paid, unused, pass.size),
      basis: `${unused} of ${pass.size} entries unused`,
      formula: `${formatCzk(pass.paid)} × ${unused} ÷ ${pass.size}`,
      releasedDates,
      todayStaysValid: usedIncludingToday > pass.entriesUsed,
    };
  }
  const elapsed = unlimitedElapsedDays(pass);
  const left = UNLIMITED_DAYS - elapsed;
  const releasedDates = Array.from({ length: left }, (_, index) =>
    addDays(pass.startDate, elapsed + index)
  );
  return {
    paid: pass.paid,
    refund: elapsed === 0 ? pass.paid : unlimitedRefund(pass.paid, elapsed),
    basis:
      elapsed === 0
        ? "Not started yet, full refund"
        : `${left} of ${UNLIMITED_DAYS} days left (today counts as used)`,
    formula:
      elapsed === 0
        ? formatCzk(pass.paid)
        : `${formatCzk(pass.paid)} × ${left} ÷ ${UNLIMITED_DAYS}`,
    releasedDates,
    todayStaysValid: elapsed > 0,
  };
};

export type UnlimitedDayState = "visited" | "missed" | "today" | "upcoming" | "released";

export const unlimitedDays = (pass: UnlimitedPass) =>
  Array.from({ length: UNLIMITED_DAYS }, (_, index) => {
    const date = addDays(pass.startDate, index);
    const visited = pass.usage.some(
      (entry) => entry.date === date && entry.kind === "day-used"
    );
    const state: UnlimitedDayState =
      pass.status === "cancelled" && date > ADMIN_TODAY
        ? "released"
        : date === ADMIN_TODAY
          ? "today"
          : date < ADMIN_TODAY
            ? visited
              ? "visited"
              : "missed"
            : "upcoming";
    return { date, state };
  });

// Synthetic capacity for the extension check.
const unavailableDates: Record<string, Record<string, string>> = {
  "Desk 14": {
    "2026-12-04": "Desk 14 is reserved by another customer",
    "2026-12-07": "Desk 14 is reserved by another customer",
  },
  "Open Space": {
    "2026-12-18": "Open Space is full (24 of 24 desks)",
  },
};

export type ExtensionCheck = {
  addedDates: string[];
  newEnd: string;
  blocking: { date: string; reason: string }[];
};

export const unlimitedExtensionCheck = (
  pass: UnlimitedPass,
  days: number
): ExtensionCheck => {
  const addedDates = Array.from({ length: days }, (_, index) =>
    addDays(pass.endDate, index + 1)
  );
  const resource = pass.deskLabel ?? "Open Space";
  const busy = unavailableDates[resource] ?? {};
  return {
    addedDates,
    newEnd: addedDates.at(-1) ?? pass.endDate,
    blocking: addedDates
      .filter((date) => busy[date])
      .map((date) => ({ date, reason: busy[date] as string })),
  };
};

export const auditActionLabel: Record<PassAuditEvent["action"], string> = {
  purchased: "Purchased",
  granted: "Granted",
  "holder-invited": "Holder invited",
  "holder-reassigned": "Holder reassigned",
  extended: "Extended",
  cancelled: "Cancelled",
  "refund-marked": "Refund marked",
};

export const adminBasePath = (locale: string) =>
  `/${locale}/prototype-passes/administration`;

export const passHref = (locale: string, passId: string) =>
  `${adminBasePath(locale)}/${passId}`;

export const customerHref = (locale: string, customerId: string) =>
  `${adminBasePath(locale)}/customers/${customerId}`;

export { formatCzk, formatPrototypeDate, UNLIMITED_DAYS };
