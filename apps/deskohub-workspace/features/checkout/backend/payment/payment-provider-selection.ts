import "server-only";
import { Effect } from "effect";
import { env } from "@/env";
import { isSyntheticE2EEmailRecipient } from "@/features/account/backend/auth/magic-link-policy";
import type { CheckoutError } from "../checkout/checkout-error";
import type { PaymentCustomer, PaymentProviderMode } from "./payment-provider";
import { allowsMockPaymentProvider } from "./payment-provider-environment";

export const isMockPaymentPreview = () => allowsMockPaymentProvider(env);

export const configuredPaymentProvider = (): PaymentProviderMode =>
  env.WORKSPACE_PAYMENT_PROVIDER ?? "nexi";

export const selectCheckoutPaymentProvider = (
  mode: PaymentProviderMode,
  customer: PaymentCustomer,
  fallbackActive: Effect.Effect<boolean, CheckoutError>
) => {
  if (mode === "mock") return Effect.succeed("mock" as const);
  if (
    mode !== "fallback" ||
    !customer.email ||
    !isSyntheticE2EEmailRecipient(customer.email)
  ) {
    return Effect.succeed("nexi" as const);
  }
  return Effect.map(fallbackActive, (active) =>
    active ? ("mock" as const) : ("nexi" as const)
  );
};
