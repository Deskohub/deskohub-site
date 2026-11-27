import "@/shared/testing/workspace-test-env";

import { expect, mock, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import { Effect } from "effect";
import { recordReservationPagePreloads } from "@/features/reservation/backend/reservation-page-preloads.service.mock";
import { defaultReservationBillingSelection } from "@/features/reservation/reservation-billing";
import { getCurrentWorkspaceDate } from "@/features/reservation/reservation-date";
import { normalizedTableReservationOrderSchema } from "@/features/reservation/table-reservation";
import { getTableReservationInterval } from "@/features/reservation/table-reservation-time";

mock.module("next/root-params", () => ({
  locale: () => Promise.resolve("en-US"),
}));

const { tableReservationPage } = await import("./table-reservation-page");

const locale = "en-US";
const today = getCurrentWorkspaceDate();
const date = today.add({ days: 2 }).toString();

test("preloads the linked table size's six-month calendar and exact price request", async () => {
  const preloads = recordReservationPagePreloads();
  const content = await Effect.runPromise(
    tableReservationPage
      .loadContent({
        checkoutAccount: { status: "signed-out" },
        locale,
        pageData: [4, 6],
        searchParams: {
          date,
          seats: "6",
          startTime: "09:15",
          endTime: "09:45",
        },
      })
      .pipe(Effect.provide(preloads.layer))
  );
  expect(content.kind).toBe("form");
  if (content.kind !== "form") throw new Error("Expected a booking form");
  expect(content.form.initialValues).toMatchObject({
    date,
    seats: 6,
    startTime: "09:15",
    endTime: "09:45",
  });
  expect(preloads.availabilityPreloads[0]?.queries).toEqual([
    {
      kind: "table",
      from: today.toString(),
      to: today.add({ months: 6 }).toString(),
      seats: 6,
    },
  ]);
  expect(preloads.advertisedPriceRequests[0]).toEqual([
    {
      locale,
      reservation: {
        kind: "table",
        details: {
          kind: "table",
          seats: 6,
          ...getTableReservationInterval(date, "09:15", "09:45"),
        },
      },
    },
  ]);
});

test("restores an active Pay selection with its hold exclusion and verified guests", async () => {
  const interval = getTableReservationInterval(date, "09:00", "10:15");
  if (!interval) throw new Error("Expected a valid test interval");
  const preloads = recordReservationPagePreloads();
  const officeSelection = {
    kind: "people" as const,
    people: { contactAttends: false, invitees: [testEmailAddress("guest")] },
  };
  const content = await Effect.runPromise(
    tableReservationPage
      .loadContent({
        checkoutAccount: { status: "signed-out" },
        locale,
        pageData: [4, 6],
        searchParams: {},
        restoredReservation: {
          officeSelection,
          reservation: normalizedTableReservationOrderSchema.make({
            kind: "table",
            seats: 6,
            ...interval,
            name: "Ada Lovelace",
            email: testEmailAddress("booker"),
            phone: "+420777000111",
            billing: defaultReservationBillingSelection,
          }),
          replacementToken: "verified-pay-state",
        },
      })
      .pipe(Effect.provide(preloads.layer))
  );
  expect(content.kind).toBe("form");
  if (content.kind !== "form") throw new Error("Expected a booking form");
  expect(content.form.initialValues).toMatchObject({
    date,
    seats: 6,
    startTime: "09:00",
    endTime: "10:15",
  });
  expect(content.form.checkoutOfficeSelection).toEqual(officeSelection);
  expect(preloads.availabilityPreloads[0]?.replacementToken).toBe(
    "verified-pay-state"
  );
});
