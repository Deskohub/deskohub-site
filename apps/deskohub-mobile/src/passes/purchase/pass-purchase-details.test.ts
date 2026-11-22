import { describe, expect, mock, test } from "bun:test";
import { Option } from "effect";
import {
  type DetailsProfile,
  initialDetailsDraft,
} from "../../booking/checkout-screen/details-form";
import { expoRouterStandIn } from "../../testing/expo-router-stand-in";
import type { PurchaseDetails } from "./pass-purchase-details";

mock.module("expo-router", () => expoRouterStandIn());
const { validatePurchaseDetails } = await import("./pass-purchase-details");

const profile: DetailsProfile = {
  self: {
    email: "buyer@example.test",
    name: Option.some("Test Buyer"),
    phone: Option.none(),
  },
  saved: {
    address: Option.none(),
    company: Option.some({
      legalName: "Test Company",
      companyId: "01234567",
      vatId: "",
      address: {
        line1: "Test Street 1",
        city: "Praha",
        postalCode: "18000",
        country: "CZ",
      },
    }),
  },
};

const initial: PurchaseDetails = {
  invoice: initialDetailsDraft(profile.saved, "CZ"),
  buyer: { firstName: "", lastName: "", phone: "" },
  gift: false,
  holderEmail: "unused@example.test",
  recipientName: "Unused",
};

describe("pass purchase Details", () => {
  test("uses the existing company invoice profile and keeps this a self-purchase", () => {
    const details = {
      ...initial,
      invoice: { ...initial.invoice, billing: "business" as const },
    };

    expect(
      validatePurchaseDetails("entry-pack", details, profile, false)
    ).toEqual({
      ok: true,
      billing: {
        purpose: "business",
        invoice: "required",
        buyer: {
          kind: "business",
          legalName: "Test Company",
          companyId: "01234567",
          address: {
            line1: "Test Street 1",
            city: "Praha",
            postalCode: "18000",
            country: "CZ",
          },
        },
      },
      input: {},
    });
  });

  test("uses one recipient email for a gift and requires the Unlimited recipient name", () => {
    const details = { ...initial, gift: true, recipientName: "" };

    expect(
      validatePurchaseDetails("entry-pack", details, profile, false)
    ).toMatchObject({
      ok: true,
      input: { holderEmail: "unused@example.test" },
    });
    expect(
      validatePurchaseDetails("unlimited", details, profile, false)
    ).toEqual({
      ok: false,
      problems: { recipientName: true },
    });
    expect(
      validatePurchaseDetails(
        "unlimited",
        { ...details, recipientName: "Test Holder" },
        profile,
        false
      )
    ).toMatchObject({
      ok: true,
      input: {
        holderEmail: "unused@example.test",
        recipientName: "Test Holder",
      },
    });
  });

  test("rejects using the same email for the buyer and a gift holder", () => {
    expect(
      validatePurchaseDetails(
        "entry-pack",
        { ...initial, gift: true, holderEmail: "BUYER@example.test" },
        profile,
        false
      )
    ).toEqual({ ok: false, problems: { holderEmail: true } });
  });
});
