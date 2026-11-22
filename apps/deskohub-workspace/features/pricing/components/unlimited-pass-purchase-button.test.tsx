import { afterAll, afterEach, expect, test } from "bun:test";
import { workspaceUseSearchParams } from "@/shared/testing/workspace-component-module-mocks";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";

registerWorkspaceComponentTestEnv();
const { cleanup, render } = await import("@testing-library/react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { UnlimitedPassPurchaseButton } = await import(
  "./unlimited-pass-purchase-button"
);

afterEach(() => {
  cleanup();
  workspaceUseSearchParams.mockReset();
  workspaceUseSearchParams.mockReturnValue(new URLSearchParams());
});
afterAll(unregisterWorkspaceComponentTestEnv);

const purchaseQuery = (href: string | null | undefined) =>
  Object.fromEntries(
    new URL(href ?? "", "https://workspace.example").searchParams
  );

const button = (tier: "open-space" | "reserved-desk-workstation") => (
  <UnlimitedPassPurchaseButton aria-label="Buy" locale="en-US" tier={tier}>
    Buy
  </UnlimitedPassPurchaseButton>
);

test("passes the booking draft Pricing opened with to the row's purchase page", () => {
  workspaceUseSearchParams.mockReturnValue(
    new URLSearchParams(
      "tier=reserved-desk&coffee=true&monitorOption=2x32-4k&startDate=2099-07-30"
    )
  );
  const view = render(button("reserved-desk-workstation"));
  const href = view.getByRole("link").getAttribute("href");
  expect(href?.startsWith("/en-US/passes/unlimited?")).toBe(true);
  // The row's tier wins; it keeps only the add-ons that tier sells.
  expect(purchaseQuery(href)).toEqual({
    tier: "reserved-desk-workstation",
    startDate: "2099-07-30",
    monitorOption: "2x32-4k",
  });
});

test("keeps coffee for the Open Space row and drops values no purchase page accepts", () => {
  workspaceUseSearchParams.mockReturnValue(
    new URLSearchParams(
      "coffee=true&monitorOption=2x32-4k&startDate=not-a-date&name=Ada&phone=%2B420777777777"
    )
  );
  const view = render(button("open-space"));
  expect(purchaseQuery(view.getByRole("link").getAttribute("href"))).toEqual({
    tier: "open-space",
    coffee: "true",
  });
});

test("links the plain tier when Pricing has no draft", () => {
  const view = render(button("open-space"));
  expect(view.getByRole("link").getAttribute("href")).toBe(
    "/en-US/passes/unlimited?tier=open-space"
  );
});

test("prerenders the plain tier link without reading the request query", () => {
  workspaceUseSearchParams.mockImplementation(() => {
    throw new Error("The prerendered link must not read search params");
  });
  // A server render shows a suspended boundary's fallback: the plain link.
  const html = renderToStaticMarkup(button("reserved-desk-workstation"));
  const link = new DOMParser()
    .parseFromString(html, "text/html")
    .querySelector("a");
  expect(link?.getAttribute("href")).toBe(
    "/en-US/passes/unlimited?tier=reserved-desk-workstation"
  );
  // Until it hydrates, it can't be followed and drop the visitor's draft.
  expect(link?.getAttribute("aria-disabled")).toBe("true");
  expect(link?.getAttribute("tabindex")).toBe("-1");
  expect(link?.classList.contains("pointer-events-none")).toBe(true);
});

test("the hydrated link can be followed", () => {
  const link = render(button("open-space")).getByRole("link");
  expect(link.getAttribute("aria-disabled")).toBeNull();
  expect(link.getAttribute("tabindex")).toBeNull();
  expect(link.classList.contains("pointer-events-none")).toBe(false);
});
