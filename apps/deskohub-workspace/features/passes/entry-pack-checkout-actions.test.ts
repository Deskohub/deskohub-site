import { expect, mock, test } from "bun:test";
import { Effect } from "effect";
import { LatePaymentVerificationService } from "@/features/checkout/backend/payment/late-payment-verification.service";
import { PaymentProviders } from "@/features/checkout/backend/payment/payment-provider";

const workspaceAction = await import("@/shared/backend/workspace-action");
mock.module("@/shared/backend/workspace-action", () => ({
  ...workspaceAction,
  defineWorkspaceAction:
    <Input, Output>(
      _options: unknown,
      run: (input: Input) => Effect.Effect<Output, unknown>
    ) =>
    (input: Input) =>
      Effect.runPromise(run(input)),
}));

const purchase = await import("./backend/entry-pack-purchase");
const observeProviders = mock((_providers: readonly string[]) => {});
mock.module("./backend/entry-pack-purchase", () => ({
  ...purchase,
  payForEntryPack: () =>
    Effect.gen(function* () {
      const providers = yield* PaymentProviders;
      yield* LatePaymentVerificationService;
      observeProviders(providers.activeProviders);
      return { status: "pending", statusUrl: "/fixture/status" };
    }),
}));

const { payEntryPackCheckout } = await import("./entry-pack-checkout-actions");

test("the exported Pay action supplies provider admission and late verification", async () => {
  const result = await payEntryPackCheckout({
    locale: "en-US",
    orderId: crypto.randomUUID(),
    accepted: true,
    acceptedDocuments: [],
    displayedPriceFingerprint: "0".repeat(64),
    billing: { purpose: "personal", invoice: "none" },
  });

  expect(result).toMatchObject({ status: "pending", statusUrl: "/fixture/status" });
  expect(observeProviders).toHaveBeenCalledWith(["nexi"]);
});
