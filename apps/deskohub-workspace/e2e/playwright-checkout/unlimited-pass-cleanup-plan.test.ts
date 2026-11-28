import "@/shared/polyfills/temporal";

import { expect, test } from "bun:test";
import {
  DotyposBranchIdSchema,
  DotyposCloudIdSchema,
  DotyposCustomerIdSchema,
  type DotyposReservation,
  DotyposReservationIdSchema,
  DotyposTableIdSchema,
} from "@deskohub/dotypos";
import { customerAccountIdSchema } from "@/features/account/customer-account";
import { orderIdSchema } from "@/features/order";
import {
  ambiguousPassDayHoldCode,
  formatPassDayMarker,
} from "@/features/passes/pass-day-marker";
import { unlimitedPassDays } from "@/features/passes/pass-offer";
import { getCoworkReservationInterval } from "@/features/reservation/cowork-reservation";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import { emptyWorkspaceE2EAccountJournal } from "../account/journal";
import { getWorkspaceE2EDateInterval } from "../capacity";
import { workspaceE2ERunIdSchema } from "../run-identifiers";
import { unlimitedPassAutoRenewalCaseId } from "./case-catalog";
import {
  planUnlimitedPassDayRelease,
  readUnlimitedPassCleanupIntent,
} from "./unlimited-pass-cleanup-plan";

const accountId = customerAccountIdSchema.make("e2e-unlimited-account");
const customerId = DotyposCustomerIdSchema.make("1");
const tableId = DotyposTableIdSchema.make("2");
const firstDay = Temporal.PlainDate.from("2026-03-20");
const orderId = orderIdSchema.make("1ab289f2-5c31-46ed-8c30-a9139e59db27");
const runId = workspaceE2ERunIdSchema.make("e2e-unlimited-cleanup-test");
const generation = "8b485528-0fd4-42ad-b3ca-edd38cd8b946";
const requestedAt = Temporal.Instant.from("2026-03-01T08:00:00Z");
const rows = Array.from({ length: unlimitedPassDays }, (_, offset) => ({
  authorAccountId: accountId,
  dotyposCustomerId: customerId,
  dotyposReservationId: null,
  failureCode: null,
  id: workspaceReservationIdSchema.make(crypto.randomUUID()),
  passDayHoldGeneration: generation,
  passDayHoldRequestedAt: requestedAt,
  passDayTableId: tableId,
  passId: orderId,
  reservationState: "creating_hold" as const,
  serviceDate: plainDateStringSchema.make(
    firstDay.add({ days: offset }).toString()
  ),
}));

const dayInterval = getCoworkReservationInterval(
  "open-space",
  firstDay.toString()
);
const record: DotyposReservation = {
  _branchId: DotyposBranchIdSchema.make("3"),
  _cloudId: DotyposCloudIdSchema.make("4"),
  _customerId: customerId,
  _tableId: tableId,
  endDate: dayInterval.endsAt.toString(),
  id: DotyposReservationIdSchema.make("5"),
  note: formatPassDayMarker(orderId, firstDay, generation),
  seats: "1",
  startDate: dayInterval.startsAt.toString(),
  status: "NEW",
};
const release = (records: readonly DotyposReservation[]) =>
  planUnlimitedPassDayRelease({
    intent: { accountId, customerId, firstDay },
    orderId,
    records,
    rows,
  });

const account = {
  authUserIds: [accountId],
  dotyposCustomerIds: [customerId],
  dotyposReservationIds: [],
  journal: {
    ...emptyWorkspaceE2EAccountJournal(unlimitedPassAutoRenewalCaseId),
    authUserIds: [accountId],
    dotyposCustomerIds: [customerId],
  },
};
const cleanupInterval = getWorkspaceE2EDateInterval({
  fromDate: firstDay.toString(),
  toDate: firstDay.add({ days: unlimitedPassDays - 1 }).toString(),
});
const intent = {
  caseId: unlimitedPassAutoRenewalCaseId,
  endDate: cleanupInterval.endDate.toISOString(),
  id: "one-unlimited-hold-intent",
  owner: { customerId },
  requestedAt: requestedAt.toString(),
  runId,
  startDate: cleanupInterval.startDate.toISOString(),
};
const emptyJournal = {
  caseId: unlimitedPassAutoRenewalCaseId,
  checkoutStates: [],
  reservationIntents: [],
  startedAt: requestedAt.toString(),
  version: 2,
};

test("reads the exact synthetic customer and full Prague calendar before either ID is captured", () => {
  const parsed = readUnlimitedPassCleanupIntent({
    account,
    runId,
    journal: { ...emptyJournal, reservationIntents: [intent] },
  });
  expect(parsed?.customerId).toBe(customerId);
  expect(parsed?.orderId).toBeUndefined();
  expect(parsed?.endsBefore.toString()).toBe("2026-04-19");
  expect(parsed?.interval).toEqual(cleanupInterval);
  expect(parsed?.paymentStarted).toBe(false);
});

test("rejects journal data from a foreign owner or a partial window", () => {
  expect(() =>
    readUnlimitedPassCleanupIntent({
      account,
      runId,
      journal: {
        ...emptyJournal,
        reservationIntents: [
          { ...intent, owner: { customerId: "other-customer" } },
        ],
      },
    })
  ).toThrow();
  expect(() =>
    readUnlimitedPassCleanupIntent({
      account,
      runId,
      journal: {
        ...emptyJournal,
        reservationIntents: [
          { ...intent, endDate: "2026-04-17T22:00:00.000Z" },
        ],
      },
    })
  ).toThrow();
  expect(() =>
    readUnlimitedPassCleanupIntent({
      account,
      runId,
      journal: { ...emptyJournal, reservationIntents: [intent, intent] },
    })
  ).toThrow();
});

test("only a valid empty Unlimited case journal proves an existing account never submitted", () => {
  expect(
    readUnlimitedPassCleanupIntent({ account, runId, journal: emptyJournal })
  ).toBeUndefined();
  for (const journal of [
    undefined,
    { ...emptyJournal, caseId: "locale-switch" },
    { ...emptyJournal, checkoutStates: [{ data: {} }] },
    { ...emptyJournal, reservationIntents: undefined },
    { ...emptyJournal, startedAt: "invalid date" },
    { ...emptyJournal, version: 1 },
  ]) {
    expect(() =>
      readUnlimitedPassCleanupIntent({ account, runId, journal })
    ).toThrow();
  }
});

test("recovers a hold from the exact generation and booking without a captured provider ID", () => {
  expect(release([record])[0]?.record).toEqual(record);
});

test("retains a captured ID for a conditional provider check when the filtered list omits it", () => {
  const days = planUnlimitedPassDayRelease({
    intent: { accountId, customerId, firstDay },
    orderId,
    records: [],
    rows: rows.map((row, offset) =>
      offset === 0 ? { ...row, dotyposReservationId: record.id } : row
    ),
  });
  expect(days[0]?.reservationId).toBe(record.id);
  expect(days[1]?.reservationId).toBeUndefined();
});

test("leaves mismatched booking facts and competing holds out of the cancellation plan", () => {
  expect(() =>
    release([{ ...record, _tableId: DotyposTableIdSchema.make("6") }])
  ).toThrow("provider ownership is ambiguous");
  expect(() =>
    release([record, { ...record, id: DotyposReservationIdSchema.make("7") }])
  ).toThrow("provider ownership is ambiguous");
  expect(() =>
    release([{ ...record, note: formatPassDayMarker(orderId, firstDay, null) }])
  ).toThrow("unproven hold");
});

test("retains a durable ambiguity when a later inventory read sees only one hold", () => {
  expect(() =>
    planUnlimitedPassDayRelease({
      intent: { accountId, customerId, firstDay },
      orderId,
      records: [record],
      rows: rows.map((row, offset) =>
        offset === 0 ? { ...row, failureCode: ambiguousPassDayHoldCode } : row
      ),
    })
  ).toThrow("recorded ambiguous hold");
});

test("a retired hold from a previous generation is irrelevant to provider cleanup", () => {
  const old = {
    ...record,
    id: DotyposReservationIdSchema.make("8"),
    note: formatPassDayMarker(orderId, firstDay, null),
    status: "CANCELLED" as const,
  };
  expect(release([old, record])[0]?.record).toEqual(record);
});
