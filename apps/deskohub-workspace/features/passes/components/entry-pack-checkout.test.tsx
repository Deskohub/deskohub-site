import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import { m } from "@/features/i18n";
import { currencyCZK } from "@/shared/money/currencies";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";

const locale = "en-US";
const product = { kind: "entry-pack", tier: "open-space", size: 5 } as const;
const begin = Promise.withResolvers<unknown>();
const beginCheckout = mock(() => begin.promise);
mock.module("../entry-pack-checkout-actions", () => ({
  beginEntryPackCheckout: beginCheckout,
  payEntryPackCheckout: mock(),
  repriceEntryPackCheckout: mock(),
}));
mock.module("next/image", () => ({ default: () => null }));

registerWorkspaceComponentTestEnv();
const { act, cleanup, fireEvent, render, waitFor } = await import(
  "@testing-library/react"
);
const { EntryPackCheckout } = await import("./entry-pack-checkout");
afterEach(cleanup);
afterAll(unregisterWorkspaceComponentTestEnv);

test("an earlier Details response cannot open Pay after the buyer changes packs", async () => {
  const buyerEmail = testEmailAddress("pack-superseded-buyer");
  const replaceState = spyOn(window.history, "replaceState");
  const view = render(
    <EntryPackCheckout
      locale={locale}
      buyer={{ kind: "linked", email: buyerEmail, name: "Fixture Buyer" }}
      initialProduct={product}
      initialStep="details"
      validity={{ 5: "2027-01-18", 10: "2027-02-18" }}
    />
  );
  fireEvent.click(
    view.getByRole("button", { name: m.checkoutContinueButton({}, { locale }) })
  );
  await waitFor(() => expect(beginCheckout).toHaveBeenCalledTimes(1));
  const path = String(replaceState.mock.calls.at(-1)?.[2]);
  replaceState.mockRestore();
  expect(
    new URL(path, "https://deskohub.example").searchParams.get("order")
  ).toMatch(/^[0-9a-f-]{36}$/);
  expect(path).not.toContain(buyerEmail);

  fireEvent.click(view.getByRole("button", { name: /choose your pack/i }));
  fireEvent.click(view.getByRole("radio", { name: /10 entries/i }));
  await act(async () => {
    begin.resolve({
      data: {
        status: "ready",
        product,
        price: {
          fingerprint: "0".repeat(64),
          subtotal: currencyCZK(115_000),
          total: currencyCZK(115_000),
          discounts: [],
        },
        validFrom: "2026-11-19",
        lastUsableDate: "2027-01-18",
        disclosure: { documents: [], earlyStartRequest: "" },
      },
    });
  });

  expect(
    view.queryByRole("heading", { name: m.checkoutPayTitle({}, { locale }) })
  ).toBeNull();
  expect(
    (view.getByRole("radio", { name: /10 entries/i }) as HTMLInputElement)
      .checked
  ).toBe(true);
});
