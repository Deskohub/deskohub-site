import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { AccountUnlimitedPass } from "@/features/account/account-unlimited-passes.server";
import { m } from "@/features/i18n";
import { type OrderId, orderIdSchema } from "@/features/order";
import {
  getUnlimitedAccessPath,
  getUnlimitedRenewalPath,
} from "@/features/passes/routes";
import { UnsavedChangesProvider } from "@/shared/components/unsaved-changes-guard";
import { currencyCZK } from "@/shared/money/currencies";
import { formatMoney } from "@/shared/money/money";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";
import { formatPlainDate } from "@/shared/utils/date-time-format";

registerWorkspaceComponentTestEnv();
const { act, cleanup, fireEvent, render, waitFor } = await import(
  "@testing-library/react"
);

type ActionResult = Awaited<
  ReturnType<
    typeof import("@/features/account/unlimited-auto-renewal-actions").cancelAccountUnlimitedAutoRenewal
  >
>;

const stopRenewal = mock(
  (_input: { readonly orderId: OrderId }): Promise<ActionResult> =>
    Promise.resolve({ data: { status: "cancelled" } })
);
const refresh = mock(() => undefined);
const navigation = await import("next/navigation");

mock.module("next/navigation", () => ({
  ...navigation,
  useRouter: () => ({ refresh }),
}));
mock.module("@/features/account/unlimited-auto-renewal-actions", () => ({
  cancelAccountUnlimitedAutoRenewal: stopRenewal,
}));

const { AccountUnlimitedPassCard } = await import("./account-unlimited-pass");

const locale = "cs-CZ";
const orderId = orderIdSchema.make(crypto.randomUUID());
const accessPath = getUnlimitedAccessPath(locale, orderId);
const renewalPath = getUnlimitedRenewalPath(locale, orderId);
const nextRenewalOn = formatPlainDate({
  date: Temporal.PlainDate.from("2026-12-10"),
  locale,
});
const amount = formatMoney(currencyCZK(3500), locale);
const pass: AccountUnlimitedPass = {
  orderId,
  tier: "Open Space",
  boughtForYou: false,
  period: "10. 11. – 9. 12. 2026",
  seating: { kind: "shared" },
  status: "active",
  day: 1,
  totalDays: 30,
  daysLeft: 30,
  accessPath,
  renewalPath,
  autoRenewal: { status: "pending", nextRenewalOn, amount },
};

function renderCard(pass: AccountUnlimitedPass) {
  return render(
    <UnsavedChangesProvider>
      <AccountUnlimitedPassCard locale={locale} pass={pass} />
    </UnsavedChangesProvider>
  );
}

beforeEach(() => {
  stopRenewal.mockClear();
  refresh.mockClear();
});
afterEach(cleanup);
afterAll(unregisterWorkspaceComponentTestEnv);

test("stops the displayed renewal while keeping paid access and manual renewal", async () => {
  const action = Promise.withResolvers<ActionResult>();
  stopRenewal.mockReturnValueOnce(action.promise);
  const view = renderCard(pass);
  const stopButton = view.getByRole("button", {
    name: m.accountUnlimitedAutoRenewalCancel({}, { locale }),
  });
  const status = view.getByRole("status");

  expect(status.textContent).toContain(
    m.accountUnlimitedAutoRenewalPlan(
      { date: nextRenewalOn, amount },
      { locale }
    )
  );
  expect(
    view.getByText(m.accountUnlimitedAutoRenewalScope({}, { locale }))
  ).toBeTruthy();

  fireEvent.click(stopButton);
  await waitFor(() =>
    expect(stopButton.getAttribute("aria-busy")).toBe("true")
  );
  expect(stopRenewal).toHaveBeenCalledWith({ orderId });
  await act(async () => action.resolve({ data: { status: "cancelled" } }));

  expect(status.textContent).toBe(
    m.accountUnlimitedAutoRenewalStopped({}, { locale })
  );
  expect(view.queryByRole("button")).toBeNull();
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(
    view
      .getByRole("link", { name: m.unlimitedAccessTodayTitle({}, { locale }) })
      .getAttribute("href")
  ).toBe(accessPath);
  expect(
    view
      .getByRole("link", { name: m.unlimitedPassRenew({}, { locale }) })
      .getAttribute("href")
  ).toBe(renewalPath);
});

test("keeps the plan and permits retry when cancellation is unavailable", async () => {
  stopRenewal.mockResolvedValueOnce({ data: { status: "unavailable" } });
  const view = renderCard(pass);
  const alert = view.getByRole("alert");
  expect(alert.textContent).toBe("");

  fireEvent.click(view.getByRole("button"));

  await waitFor(() =>
    expect(alert.textContent).toBe(
      m.accountUnlimitedAutoRenewalError({}, { locale })
    )
  );
  expect(view.getByRole("button").hasAttribute("disabled")).toBe(false);
  expect(view.getByRole("status").textContent).toContain(nextRenewalOn);
  expect(refresh).not.toHaveBeenCalled();
});

test("shows a stopped renewal loaded from the account and no control for a one-time pass", () => {
  const stopped = renderCard({ ...pass, autoRenewal: { status: "cancelled" } });
  expect(stopped.getByRole("status").textContent).toBe(
    m.accountUnlimitedAutoRenewalStopped({}, { locale })
  );
  expect(stopped.queryByRole("button")).toBeNull();
  stopped.unmount();

  const oneTime = renderCard({ ...pass, autoRenewal: undefined });
  expect(
    oneTime.queryByText(m.accountUnlimitedAutoRenewalTitle({}, { locale }))
  ).toBeNull();
});
