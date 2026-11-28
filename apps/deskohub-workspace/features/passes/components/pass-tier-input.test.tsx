import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";
import type { PassProduct, PassTier } from "../pass-offer";

mock.module("next/image", () => ({ default: () => null }));
const { PassTierInput } = await import("./pass-tier-input");

beforeAll(registerWorkspaceComponentTestEnv);
afterAll(unregisterWorkspaceComponentTestEnv);

function tierCards(kind: PassProduct["kind"]) {
  const html = renderToStaticMarkup(
    <PassTierInput
      kind={kind}
      locale="en-US"
      onChange={() => {}}
      priceForTier={() => "CZK 1"}
      tier="open-space"
    />
  );
  const document = new DOMParser().parseFromString(html, "text/html");
  return (tier: PassTier) =>
    document.querySelector(`[data-reservation-type-option="${tier}"]`)
      ?.textContent;
}

test("describes the membership period and included coffee on Reserved Desk tiers", () => {
  const card = tierCards("unlimited");

  expect(card("open-space")).toContain(
    "Any free desk in Open Space every day, 00:00–17:00."
  );
  expect(card("open-space")).not.toContain("Coffee included");
  expect(card("reserved-desk")).toContain(
    "The same desk is yours on all 30 days, around the clock."
  );
  expect(card("reserved-desk")).toContain("Coffee included");
  expect(card("reserved-desk-workstation")).toContain(
    "The same desk with two monitors on all 30 days, around the clock."
  );
  expect(card("reserved-desk-workstation")).toContain("Coffee included");
});

test("keeps the daily description and perks for Entry packs", () => {
  const card = tierCards("entry-pack");

  expect(card("open-space")).toContain("Any free desk, until 17:00");
  expect(card("reserved-desk")).toContain("Your own desk all day");
  expect(card("reserved-desk-workstation")).toContain("Your own desk all day");
});
