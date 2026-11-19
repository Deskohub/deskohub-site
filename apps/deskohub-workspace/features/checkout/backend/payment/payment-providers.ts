import { Effect, Layer } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { env } from "@/env";
import { WorkspaceNexiLayer } from "@/shared/backend/config/nexi.config";
import { CheckoutError } from "../checkout/checkout-error";
import { makeMockPaymentProvider } from "./mock-payment-provider";
import { makeNexiPaymentProvider } from "./nexi-payment-provider";
import {
  type PaymentProviderAdapter,
  PaymentProviderError,
  PaymentProviders,
} from "./payment-provider";
import { PaymentProviderFallbackRepository } from "./payment-provider-fallback.repository";
import {
  configuredPaymentProvider,
  isMockPaymentPreview,
  selectCheckoutPaymentProvider,
} from "./payment-provider-selection";

export {
  nexiRequestTimeout as paymentVerificationRequestTimeout,
  nexiRequestWorstCaseDuration as paymentLookupWorstCaseDuration,
} from "@/shared/backend/config/nexi.config";

const unavailableMockProvider: PaymentProviderAdapter = {
  unconfirmedSessionFailureCode: "mock_payment_session_unconfirmed",
  prepareSession: () =>
    Effect.fail(
      new CheckoutError({
        code: "checkout_failed",
        message: "Test payment sessions are unavailable.",
      })
    ),
  lookup: () =>
    Effect.fail(
      new PaymentProviderError({ message: "Test payments are unavailable." })
    ),
  verify: () =>
    Effect.fail(
      new PaymentProviderError({ message: "Test payments are unavailable." })
    ),
};

export const PaymentProvidersFromNexi = Layer.effect(
  PaymentProviders,
  Effect.map(makeNexiPaymentProvider, (nexi) =>
    PaymentProviders.of({
      activeProviders: ["nexi"],
      selectForCustomer: () => Effect.succeed("nexi"),
      forAttempt: (provider) =>
        provider === "nexi" ? nexi : unavailableMockProvider,
    })
  )
);

const PreviewPaymentProviders = Layer.effect(
  PaymentProviders,
  Effect.gen(function* () {
    const nexi = yield* makeNexiPaymentProvider;
    const mock = yield* makeMockPaymentProvider;
    const gate = yield* PaymentProviderFallbackRepository;
    const mode = configuredPaymentProvider();
    const deploymentHost = env.VERCEL_URL;
    const adapters = { nexi, mock };

    return PaymentProviders.of({
      activeProviders: ["nexi", "mock"],
      forAttempt: (provider) => adapters[provider],
      selectForCustomer: (customer) =>
        selectCheckoutPaymentProvider(
          mode,
          customer,
          deploymentHost
            ? gate.isActive(deploymentHost).pipe(
                Effect.mapError(
                  (cause) =>
                    new CheckoutError({
                      code: "checkout_failed",
                      message:
                        "The deployment payment provider could not be selected.",
                      cause,
                    })
                )
              )
            : Effect.succeed(false)
        ),
    });
  })
).pipe(
  Layer.provide(PaymentProviderFallbackRepository.Default),
  Layer.provide(Layer.mergeAll(WorkspaceNexiLayer, WorkspaceDatabase.Default))
);

export const PaymentProvidersLive =
  isMockPaymentPreview() && configuredPaymentProvider() !== "nexi"
    ? PreviewPaymentProviders
    : PaymentProvidersFromNexi.pipe(Layer.provide(WorkspaceNexiLayer));
