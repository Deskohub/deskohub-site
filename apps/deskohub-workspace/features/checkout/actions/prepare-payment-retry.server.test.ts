import "@/shared/polyfills/temporal";
import "@/shared/testing/workspace-test-env";

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Effect, Layer } from "effect";
import {
  CheckoutPaymentRetryService,
  type PaymentRetryInput,
  type PaymentRetryPreparation,
} from "@/features/checkout/backend/checkout/checkout-payment-retry.service";
import type { CheckoutSummary } from "@/features/checkout/checkout-summary";
import { getReservationAccessCookieName } from "@/features/reservation/backend/reservation-access-cookie";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import { mockWorkspaceActionRequest } from "@/shared/testing/workspace-action-request.test-utils";

mock.module("server-only", () => ({}));

const request = await mockWorkspaceActionRequest();
const { preparePaymentRetryForVisitor, preparePaymentRetrySchema } =
  await import("./prepare-payment-retry.server");

const orderId = "reservation-payment-retry-action" as WorkspaceReservationId;
const payUrl = "/en-US/checkout/pay?state=sealed-retry-state";

const ready: PaymentRetryPreparation = {
  state: "ready",
  payState: {
    freshPayUrl: payUrl,
    freshPayStateToken: "sealed-retry-state",
    expiresAt: "2026-11-15T12:10:00Z",
  },
  checkout: {
    orderId,
    expiresAt: "2026-11-15T12:10:00Z",
    summary: {} as CheckoutSummary,
    changedKeys: undefined,
    earlyPerformanceConsent: {
      required: false,
      requiredFrom: "2026-11-29T12:00:00Z",
    },
  },
};

const prepareWith = async (
  input: unknown,
  answer: PaymentRetryPreparation = { state: "not_found" }
) => {
  const prepare = mock((_input: PaymentRetryInput) => Effect.succeed(answer));
  const validated =
    await preparePaymentRetrySchema["~standard"].validate(input);
  if (validated.issues) throw new Error("The retry input was rejected");
  const result = await Effect.runPromise(
    preparePaymentRetryForVisitor(validated.value).pipe(
      Effect.provide(Layer.mock(CheckoutPaymentRetryService, { prepare }))
    )
  );
  return { prepare, result };
};

describe("paying an order again from the status page", () => {
  beforeEach(() => {
    request.reset();
  });

  test("asks the service with the order's access cookie and the page locale", async () => {
    request.setCookie(getReservationAccessCookieName(orderId), "access-cookie");

    const { prepare } = await prepareWith({ orderId, locale: "cs-CZ" });

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]?.[0]).toEqual({
      accessCookie: "access-cookie",
      locale: "cs-CZ",
      orderId,
    });
  });

  test("asks without a cookie when the visitor holds none for the order", async () => {
    request.setCookie(
      getReservationAccessCookieName("another-order" as WorkspaceReservationId),
      "other-cookie"
    );

    const { prepare } = await prepareWith({ orderId, locale: "en-US" });

    expect(prepare.mock.calls[0]?.[0].accessCookie).toBeUndefined();
  });

  test("never takes anything but the order and locale from the client", async () => {
    const { prepare } = await prepareWith({
      orderId,
      locale: "en-US",
      payUrl: "https://attacker.example.test/pay",
      variant: "retry",
    });

    expect(Object.keys(prepare.mock.calls[0]?.[0] ?? {}).sort()).toEqual([
      "accessCookie",
      "locale",
      "orderId",
    ]);
  });

  test("opens the Pay page of the order's fresh Pay state", async () => {
    const { result } = await prepareWith({ orderId, locale: "en-US" }, ready);

    expect(result).toEqual({ state: "ready", payUrl });
  });

  test("hands the client only where to go, never the checkout it describes", async () => {
    const { result } = await prepareWith({ orderId, locale: "en-US" }, ready);

    expect(Object.keys(result).sort()).toEqual(["payUrl", "state"]);
  });

  test.each<[PaymentRetryPreparation, string]>([
    [{ state: "spot_unavailable" }, "spot_unavailable"],
    [{ state: "payment_settling" }, "payment_settling"],
    [{ state: "not_found" }, "refused"],
    [{ state: "not_retryable", reason: "superseded" }, "refused"],
    [{ state: "not_retryable", reason: "details_unavailable" }, "refused"],
  ])("answers %o as %s", async (answer, state) => {
    const { result } = await prepareWith({ orderId, locale: "en-US" }, answer);

    expect(result).toEqual({ state } as never);
  });

  test.each([
    { orderId: "", locale: "en-US" },
    { orderId, locale: "xx-XX" },
    { locale: "en-US" },
  ])("rejects an incomplete or foreign input", async (input) => {
    const validated =
      await preparePaymentRetrySchema["~standard"].validate(input);

    expect(validated.issues?.length).toBeGreaterThan(0);
  });
});
