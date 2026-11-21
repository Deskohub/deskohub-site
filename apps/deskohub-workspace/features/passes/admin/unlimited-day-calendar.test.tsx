import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import { UnlimitedDayCalendar } from "./unlimited-day-calendar";

test("displays recorded issuance and marks today separately", () => {
  const today = plainDateStringSchema.make("2026-11-21");
  const html = renderToStaticMarkup(
    <UnlimitedDayCalendar
      detail={{
        today,
        days: [
          {
            id: workspaceReservationIdSchema.make(crypto.randomUUID()),
            date: plainDateStringSchema.make("2026-11-20"),
            status: "confirmed",
            tableId: null,
            accessIssued: true,
          },
          {
            id: workspaceReservationIdSchema.make(crypto.randomUUID()),
            date: today,
            status: "confirmed",
            tableId: null,
            accessIssued: false,
          },
          {
            id: workspaceReservationIdSchema.make(crypto.randomUUID()),
            date: plainDateStringSchema.make("2026-11-22"),
            status: "cancelled",
            tableId: null,
            accessIssued: false,
          },
        ],
      }}
      locale="en-US"
    />
  );
  expect(html).toContain("Usage");
  expect(html).toContain("Code issued");
  expect(html).toContain("Today");
  expect(html).toContain("Released");
  expect(html).toMatch(/datetime="2026-11-21"/i);
});
