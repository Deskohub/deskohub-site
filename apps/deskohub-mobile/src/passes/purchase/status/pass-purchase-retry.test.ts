import { expect, mock, test } from "bun:test";
import type { CustomerPassPurchaseStatus } from "@deskohub/workspace-customer-api";
import { expoRouterStandIn } from "../../../testing/expo-router-stand-in";

mock.module("expo-router", () => expoRouterStandIn());
const {
  availablePassPurchaseContinuation,
  confirmedRetryPayload,
  passPurchaseResumeUrl,
} = await import("./use-pass-purchase-payment");

const amount = { value: 45_000, currency: "CZK", exponent: 2 } as const;
const approved = {
  priorPaymentAttemptId: "previous-attempt",
  price: {
    fingerprint: "a".repeat(64),
    subtotal: amount,
    total: amount,
    discounts: [],
  },
  disclosure: {
    documents: [
      {
        key: "terms-and-conditions",
        path: "/cs-CZ/podminky",
        hash: "terms-revision",
        hashAlgorithm: "sha256",
      },
      {
        key: "operating-rules",
        path: "/cs-CZ/provozni-rad",
        hash: "rules-revision",
        hashAlgorithm: "sha256",
      },
    ],
    earlyStartRequest: "Synthetic early start disclosure",
  },
} satisfies NonNullable<CustomerPassPurchaseStatus["retry"]>;

const status = {
  orderId: "836223a1-29fd-4c4f-b876-49782ae18eda",
  status: "cancelled",
  productKind: "unlimited",
  tier: "open-space",
  statusPath: "/cs-CZ/status",
  retry: approved,
} satisfies CustomerPassPurchaseStatus;

test("retries the confirmed attempt with the reviewed price and legal evidence", () => {
  expect(confirmedRetryPayload(status, approved, "native-app")).toEqual({
    productKind: "unlimited",
    priorPaymentAttemptId: approved.priorPaymentAttemptId,
    displayedPriceFingerprint: approved.price.fingerprint,
    accepted: true,
    acceptedDocuments: [
      { key: "terms-and-conditions", hash: "terms-revision" },
      { key: "operating-rules", hash: "rules-revision" },
    ],
    unlimitedEarlyStartAccepted: true,
    returnTarget: "native-app",
  });
  expect(
    confirmedRetryPayload(
      { ...status, productKind: "entry-pack" },
      approved,
      "web-app"
    )
  ).not.toHaveProperty("unlimitedEarlyStartAccepted");
});

test("requires the exact prior attempt, quote, and disclosure to remain eligible", () => {
  const changed = [
    { ...status, status: "checking" },
    { ...status, status: "paid" },
    { ...status, retry: { ...approved, priorPaymentAttemptId: "new-attempt" } },
    {
      ...status,
      retry: {
        ...approved,
        price: { ...approved.price, fingerprint: "b".repeat(64) },
      },
    },
    {
      ...status,
      retry: {
        ...approved,
        disclosure: {
          ...approved.disclosure,
          earlyStartRequest: "Changed disclosure",
        },
      },
    },
  ] satisfies CustomerPassPurchaseStatus[];
  for (const purchase of changed) {
    expect(
      confirmedRetryPayload(purchase, approved, "native-app")
    ).toBeUndefined();
  }
});

test("offers only the continuation supported by the current status", () => {
  const resumePath = "/cs-CZ/passes/unlimited?step=pay";
  const paymentUrl = "https://payment.test/hosted";
  expect(
    availablePassPurchaseContinuation({
      ...status,
      status: "not_started",
      resumePath,
    })
  ).toEqual({ kind: "resume", path: resumePath });
  expect(
    availablePassPurchaseContinuation({
      ...status,
      status: "pending",
      paymentUrl,
    })
  ).toEqual({ kind: "reopen", url: paymentUrl });
  expect(
    availablePassPurchaseContinuation({
      ...status,
      status: "paid",
      paymentUrl,
      resumePath,
    })
  ).toBeUndefined();
});

test("resumes Pay only at an owned relative workspace path", () => {
  const origin = "https://workspace.deskohub.test";
  expect(passPurchaseResumeUrl("/passes/pay", origin)).toBe(
    `${origin}/passes/pay`
  );
  expect(passPurchaseResumeUrl("//other.test/pay", origin)).toBeUndefined();
  expect(
    passPurchaseResumeUrl("https://other.test/pay", origin)
  ).toBeUndefined();
});
