import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import { orderIdSchema } from "@/features/order";
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
  expect(continueButton.disabled).toBe(true);
  fireEvent.click(view.getByRole("button", { name: /November 1st, 2026/i }));
  expect(continueButton.disabled).toBe(false);
  expect(view.getAllByText("Not free on all 30 days")).toHaveLength(3);
  fireEvent.click(view.getByRole("radio", { name: /32.*qhd/i }));
  expect(new URL(window.location.href).searchParams.has("startDate")).toBe(
    false
  );
  expect(continueButton.disabled).toBe(true);
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
  fireEvent.click(
    view.getByRole("switch", {
      name: m.reservationPurposeBusinessLabel({}, { locale }),
    })
  );
  const billingFields = [
    [m.reservationBillingCompanyNameLabel({}, { locale }), "Fixture Company"],
    [m.reservationBillingCompanyIdLabel({}, { locale }), "12345679"],
    [m.reservationBillingAddressLine1Label({}, { locale }), "Fixture Street 1"],
    [m.reservationBillingCityLabel({}, { locale }), "Praha"],
    [m.reservationBillingPostalCodeLabel({}, { locale }), "18000"],
  ] as const;
  for (const [label, value] of billingFields) {
    fireEvent.change(view.getByLabelText(label, { exact: false }), {
      target: { value },
    });
  }
  fireEvent.click(
    view.getByRole("button", {
      name: m.reservationSelectionChange({}, { locale }),
    })
  );
  await waitFor(() =>
    expect(
      view.getByRole<HTMLButtonElement>("button", { name: /continue/i })
        .disabled
    ).toBe(false)
  );
  fireEvent.click(view.getByRole("button", { name: /continue/i }));
  expect(
    view.getByLabelText<HTMLInputElement>(
      m.entryPackCheckoutHolderEmail({}, { locale })
    ).value
  ).toBe(holderEmail);
  expect(
    view.getByLabelText<HTMLInputElement>(
      m.reservationBillingCompanyNameLabel({}, { locale }),
      { exact: false }
    ).value
  ).toBe("Fixture Company");

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
        unlimitedEarlyStartAccepted: true,
        acceptedDocuments: [
          { key: "terms-and-conditions", hash: "one" },
          { key: "operating-rules", hash: "two" },
        ],
        billing: {
          purpose: "business",
          invoice: "required",
          buyer: {
            kind: "business",
            legalName: "Fixture Company",
            companyId: "12345679",
            address: {
              line1: "Fixture Street 1",
              city: "Praha",
              postalCode: "18000",
              country: "CZ",
            },
          },
        },
        displayedPriceFingerprint: "a".repeat(64),
      }),
    ])
  );
});

test("editing an owned draft sends a new order and reports the capacity refusal", async () => {
  const existingOrderId = orderIdSchema.make(
    "018f8000-0000-7000-8000-000000000001"
  );
  const requests: unknown[] = [];
  const view = render(
    <QueryProvider>
      <UnlimitedPassCheckout
        {...base}
        initialDetails={{
          tier: "open-space",
          coffee: false,
          startDate: openSpaceStart,
        }}
        draft={{ kind: "resume", orderId: existingOrderId }}
        beginCheckout={async (input) => {
          requests.push(input);
          return {
            data: {
              status: "capacity_unavailable",
              blockingDates: [monitorStart],
            },
          };
        }}
      />
    </QueryProvider>
  );
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
    expect(view.getByText(/pass can’t cover Nov 2, 2026/i)).toBeDefined()
  );
  expect(requests).toEqual([
    expect.objectContaining({
      orderId: expect.not.stringMatching(existingOrderId),
      supersedeOrderId: existingOrderId,
      holderEmail,
    }),
  ]);
  expect(
    view.getByRole<HTMLButtonElement>("button", { name: /continue/i }).disabled
  ).toBe(true);
});

test("Details cannot hand off another selection while Begin is creating holds", async () => {
  const response = Promise.withResolvers<{
    data: { status: "purchase_error"; reason: "unavailable" };
  }>();
  const beginCheckout = mock(() => response.promise);
  const view = render(
    <QueryProvider>
      <UnlimitedPassCheckout
        {...base}
        initialDetails={{
          tier: "open-space",
          coffee: false,
          startDate: openSpaceStart,
        }}
        beginCheckout={beginCheckout}
      />
    </QueryProvider>
  );
  const submit = view.getByRole<HTMLButtonElement>("button", {
    name: /continue/i,
  });
  fireEvent.click(submit);
  await waitFor(() => expect(beginCheckout).toHaveBeenCalledTimes(1));
  expect(
    view.queryByRole("button", { name: /choose your 30 days/i })
  ).toBeNull();
  expect(
    view.getByRole<HTMLButtonElement>("button", {
      name: m.reservationSelectionChange({}, { locale }),
    }).disabled
  ).toBe(true);

  const form = submit.form;
  if (!form) throw new Error("Continue is missing its form");
  fireEvent.submit(form);
  expect(beginCheckout).toHaveBeenCalledTimes(1);
  response.resolve({
    data: { status: "purchase_error", reason: "unavailable" },
  });
  await waitFor(() =>
    expect(
      view.getByRole("button", { name: /choose your 30 days/i })
    ).toBeDefined()
  );
});

test("later calendar months load their own authoritative availability", async () => {
  const futureMonth = plainDateStringSchema.make("2027-02-01");
  const futureStart = plainDateStringSchema.make("2027-02-10");
  const getAvailability = mock(async ({ startsOn }: { startsOn?: string }) => ({
    data: {
      ...availability,
      starts: {
        ...availability.starts,
        "open-space": startsOn === futureMonth ? [futureStart] : [],
      },
    },
  }));
  const view = render(
    <QueryProvider>
      <UnlimitedPassCheckout
        {...base}
        initialStartDate={futureStart}
        initialBounds={{
          today,
          lastStartDate: plainDateStringSchema.make("2027-04-25"),
        }}
        getAvailability={getAvailability}
      />
    </QueryProvider>
  );
  await waitFor(() =>
    expect(
      view.getByRole<HTMLButtonElement>("button", { name: /continue/i })
        .disabled
    ).toBe(false)
  );
  expect(getAvailability).toHaveBeenCalledWith({
    locale,
    startsOn: futureMonth,
  });
  fireEvent.click(view.getByRole("button", { name: /next month/i }));
  await waitFor(() =>
    expect(getAvailability).toHaveBeenCalledWith({
      locale,
      startsOn: "2027-03-01",
    })
  );
  expect(
    view.getByRole<HTMLButtonElement>("button", { name: /continue/i }).disabled
  ).toBe(true);
});

test("an expired status-originated payment retry returns to that same order", async () => {
  const orderId = orderIdSchema.make("018f8000-0000-7000-8000-000000000002");
  const replace = spyOn(window.location, "replace").mockImplementation(
    () => {}
  );
  try {
    const view = render(
      <QueryProvider>
        <UnlimitedPassCheckout
          {...base}
          retryPayment={{
            orderId,
            selection: {
              tier: "open-space",
              coffee: false,
              startDate: openSpaceStart,
            },
            state: {
              validFrom: openSpaceStart,
              lastUsableDate: "2026-11-30",
              billing: { purpose: "personal", invoice: "none" },
              disclosure: { documents: [] },
              price: {
                fingerprint: "a".repeat(64),
                subtotal: currencyCZK(349000),
                total: currencyCZK(349000),
                discounts: [],
              },
            },
          }}
          payCheckout={async () => ({
            data: { status: "purchase_error", reason: "quote-expired" },
          })}
        />
      </QueryProvider>
    );
    fireEvent.click(view.getByRole("checkbox"));
    fireEvent.click(view.getByRole("button", { name: /pay/i }));
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(
        `/en-US/reservation/status/${orderId}`
      )
    );
  } finally {
    replace.mockRestore();
  }
});
