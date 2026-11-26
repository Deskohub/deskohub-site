import "server-only";

import { env } from "@/env";

type RenewalPreviewEnvironment = Pick<
  typeof env,
  | "VERCEL_ENV"
  | "WORKSPACE_RUNTIME_HOST"
  | "NEXI_API_ORIGIN"
  | "UNLIMITED_AUTO_RENEWAL_PREVIEW"
>;

/** Exposes the renewal agreement only on an opted-in Workspace sandbox preview. */
export const isUnlimitedAutoRenewalPreviewEnabled = (
  environment: RenewalPreviewEnvironment = env
) =>
  environment.VERCEL_ENV === "preview" &&
  environment.WORKSPACE_RUNTIME_HOST !== "container" &&
  environment.UNLIMITED_AUTO_RENEWAL_PREVIEW === "true" &&
  new URL(environment.NEXI_API_ORIGIN).origin ===
    "https://xpaysandbox.nexigroup.com";
