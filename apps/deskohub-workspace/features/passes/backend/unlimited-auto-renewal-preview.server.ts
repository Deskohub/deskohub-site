import "server-only";

import { env, vercelHostStage } from "@/env";

type RenewalPreviewEnvironment = Pick<
  typeof env,
  | "VERCEL_ENV"
  | "WORKSPACE_RUNTIME_HOST"
  | "WORKSPACE_PAYMENT_PROVIDER"
  | "NEXI_API_ORIGIN"
  | "NEXI_CHECKOUT_CURRENCY_OVERRIDE"
  | "UNLIMITED_AUTO_RENEWAL_PREVIEW"
>;

/** Exposes the renewal agreement only on an opted-in Workspace sandbox preview. */
export const isUnlimitedAutoRenewalPreviewEnabled = (
  environment: RenewalPreviewEnvironment = env,
  vercelStage = vercelHostStage
) =>
  vercelStage === "preview" &&
  environment.VERCEL_ENV === "preview" &&
  environment.WORKSPACE_RUNTIME_HOST !== "container" &&
  (environment.WORKSPACE_PAYMENT_PROVIDER ?? "nexi") === "nexi" &&
  environment.NEXI_CHECKOUT_CURRENCY_OVERRIDE === "EUR" &&
  environment.UNLIMITED_AUTO_RENEWAL_PREVIEW === "true" &&
  new URL(environment.NEXI_API_ORIGIN).origin ===
    "https://xpaysandbox.nexigroup.com";
