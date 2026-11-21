import { expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RouteLocaleProvider } from "@/features/i18n/route-locale";
import { orderIdSchema } from "@/features/order";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import type { AdminPassDetail } from "./pass-reads";

mock.module("@/features/i18n/server/request-locale", () => ({
  getRequestLocale: () => Promise.resolve("en-US"),
}));
mock.module("./pass-page-data.server", () => ({
  loadAdminPass: mock(),
}));

const { AdminPassDetailView } = await import("./pass-detail-screen");
const { passValidityRange } = await import("./pass-presentation");

const detail: AdminPassDetail & {
  readonly deskLabels: ReadonlyMap<never, string>;
} = {
  pass: {
    id: orderIdSchema.make(crypto.randomUUID()),
    product: "unlimited",
    tier: "reserved-desk",
    entryCount: null,
    entriesLeft: null,
    day: null,
    status: "pending_payment",
    paid: null,
    complimentary: false,
    claimed: true,
    holder: { customerId: null, name: null, email: null, deleted: false },
    buyer: null,
    validFrom: plainDateStringSchema.make("2026-11-01"),
    validUntil: plainDateStringSchema.make("2026-12-01"),
    accessEndsOn: null,
  },
  today: plainDateStringSchema.make("2026-10-01"),
  accessEndsOn: null,
  storedStatus: "pending_payment",
  paymentState: "not_started",
  fulfillmentState: "not_started",
  activePaymentAttemptId: null,
  createdAt: Temporal.Instant.from("2026-10-01T12:00:00Z"),
  paidAt: null,
  coffee: false,
  monitor: null,
  attempts: [],
  consent: [],
  withdrawal: null,
  claims: [],
  days: [],
  moves: [],
  deskLabels: new Map(),
};

test("uses the shortened access period and shows an empty period for withdrawal before start", () => {
  const shortened = {
    ...detail.pass,
    accessEndsOn: plainDateStringSchema.make("2026-11-15"),
  };
  expect(passValidityRange(shortened, "en-US")).toContain("Nov 14, 2026");
  expect(
    passValidityRange(
      { ...shortened, accessEndsOn: shortened.validFrom },
      "en-US"
    )
  ).toBe("No access days");
});

test("shows the creation time and claimed holder on a pending order", () => {
  const html = renderToStaticMarkup(
    <RouteLocaleProvider locale="en-US">
      <AdminPassDetailView detail={detail} locale="en-US" />
    </RouteLocaleProvider>
  );
  expect(html).toContain("Created");
  expect(html).toContain("Claimed");
  expect(html).not.toContain("Purchased");
});
