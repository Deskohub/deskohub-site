import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import { currencyCZK } from "@/shared/money/currencies";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";
import { plainDateStringSchema } from "@/shared/utils/temporal";

mock.module("next/image", () => ({ default: () => null }));

registerWorkspaceComponentTestEnv();
const { cleanup, fireEvent, render, waitFor } = await import(
  "@testing-library/react"
);
const { QueryProvider } = await import("@/shared/components/query-provider");
const { m } = await import("@/features/i18n");
const { UnlimitedPassCheckout } = await import("./unlimited-pass-checkout");

afterEach(cleanup);
afterAll(unregisterWorkspaceComponentTestEnv);

const locale = "en-US";
const today = plainDateStringSchema.make("2026-10-25");
const openSpaceStart = plainDateStringSchema.make("2026-11-01");
const monitorStart = plainDateStringSchema.make("2026-11-02");
const lastStartDate = plainDateStringSchema.make("2026-11-24");
const buyerEmail = testEmailAddress("unlimited-pass-buyer");
const holderEmail = testEmailAddress("unlimited-pass-holder");
const earlyStart = m.unlimitedPassEarlyStartConsent({}, { locale });
const availability = {
  status: "ready",
  today,
  lastStartDate,
  starts: {
    "open-space": [openSpaceStart],
    "reserved-desk": [],
    "reserved-desk-workstation": {
      "2x27-qhd": [openSpaceStart],
      "2x32-qhd": [monitorStart],
      "2x27-4k": [],
      "2x32-4k": [],
    },
  },
} as const;

const base = {
  locale,
  buyer: { kind: "linked", name: "Fixture Buyer", email: buyerEmail },
  initialOptions: { tier: "open-space", coffee: false },
  initialStartDate: openSpaceStart,
  initialBounds: { today, lastStartDate },
  discountCodeEntryEnabled: false,
  getAvailability: async () => ({ data: availability }),
  beginCheckout: async () => ({}),
  repriceCheckout: async () => ({}),
  payCheckout: async () => ({}),
} as const;

test("Continue uses the selected tier's full-window starts and discards irrelevant add-ons", async () => {
  const view = render(
    <QueryProvider>
      <UnlimitedPassCheckout {...base} />
    </QueryProvider>
  );
  const continueButton = view.getByRole<HTMLButtonElement>("button", {
    name: /continue/i,
  });
  await waitFor(() => expect(continueButton.disabled).toBe(false));
  expect(
    view.getByRole("switch", { name: /coffee for 30 days/i })
  ).toBeDefined();
  fireEvent.click(view.getByRole("switch"));
  fireEvent.click(
    view.getByRole("radio", { name: /^reserved desk (?!with workstation)/i })
  );
  expect(view.queryByRole("switch")).toBeNull();
  expect(view.queryByText(/same monitor setup/i)).toBeNull();
  expect(
    view.getByText("There are no available start dates for this selection.")
  ).toBeDefined();
  expect(continueButton.disabled).toBe(true);

  fireEvent.click(
    view.getByRole("radio", { name: /reserved desk with workstation/i })
  );
  expect(continueButton.disabled).toBe(false);
  expect(
    view.getByRole<HTMLInputElement>("radio", { name: /32.*qhd/i }).disabled
  ).toBe(true);
  const enabledStart = view.getByRole("button", {
    name: /November 1st, 2026/i,
  });
  fireEvent.click(enabledStart);
  expect(continueButton.disabled).toBe(true);
  fireEvent.click(view.getByRole("radio", { name: /32.*qhd/i }));
  const unavailableStart = view.getByRole<HTMLButtonElement>("button", {
    name: /November 1st, 2026/i,
  });
  expect(
    unavailableStart.disabled ||
      unavailableStart.getAttribute("aria-disabled") === "true"
  ).toBe(true);
  fireEvent.click(unavailableStart);
  expect(continueButton.disabled).toBe(true);
  fireEvent.click(view.getByRole("button", { name: /November 2nd, 2026/i }));
  expect(continueButton.disabled).toBe(false);
  fireEvent.click(continueButton);
  expect(view.getByText("Reserved Desk with workstation")).toBeDefined();
});

test("gift Details preserves the buyer and billing, and Pay renders one combined consent", async () => {
  const requests: unknown[] = [];
  const payments: unknown[] = [];
  const view = render(
    <QueryProvider>
      <UnlimitedPassCheckout
        {...base}
        beginCheckout={async (input) => {
          requests.push(input);
          return {
            data: {
              status: "ready",
              validFrom: openSpaceStart,
              lastUsableDate: "2026-11-30",
              price: {
                fingerprint: "a".repeat(64),
                subtotal: currencyCZK(418000),
                total: currencyCZK(418000),
                discounts: [],
              },
              disclosure: {
                documents: [
                  {
                    key: "terms-and-conditions",
                    path: "/terms",
                    hash: "one",
                    hashAlgorithm: "sha256",
                  },
                  {
                    key: "operating-rules",
                    path: "/rules",
                    hash: "two",
                    hashAlgorithm: "sha256",
                  },
                ],
                earlyStartRequest: earlyStart,
              },
            },
          };
        }}
        payCheckout={async (input) => {
          payments.push(input);
          return { data: { status: "purchase_error", reason: "unavailable" } };
        }}
      />
    </QueryProvider>
  );
  const continueButton = view.getByRole<HTMLButtonElement>("button", {
    name: /continue/i,
  });
  await waitFor(() => expect(continueButton.disabled).toBe(false));
  fireEvent.click(view.getByRole("switch"));
  fireEvent.click(continueButton);
  fireEvent.click(
    view.getByRole("checkbox", {
      name: m.entryPackCheckoutGift({}, { locale }),
    })
  );
  fireEvent.change(
    view.getByLabelText(m.entryPackCheckoutHolderEmail({}, { locale })),
    {
      target: { value: holderEmail },
    }
  );
  fireEvent.click(view.getByRole("button", { name: /continue/i }));
  await waitFor(() =>
    expect(view.getByText(earlyStart, { exact: false })).toBeDefined()
  );
  expect(requests).toEqual([
    expect.objectContaining({
      locale,
      buyerEmail,
      holderEmail,
      selection: {
        tier: "open-space",
        startDate: openSpaceStart,
        coffee: true,
      },
    }),
  ]);
  expect(view.getAllByRole("checkbox")).toHaveLength(1);
  const pay = view.getByRole<HTMLButtonElement>("button", { name: /pay/i });
  expect(pay.disabled).toBe(true);
  fireEvent.click(view.getByRole("checkbox"));
  fireEvent.click(pay);
  await waitFor(() =>
    expect(payments).toEqual([
      expect.objectContaining({
        accepted: true,
        acceptedDocuments: [
          { key: "terms-and-conditions", hash: "one" },
          { key: "operating-rules", hash: "two" },
        ],
        billing: { purpose: "personal", invoice: "none" },
        displayedPriceFingerprint: "a".repeat(64),
      }),
    ])
  );
});
