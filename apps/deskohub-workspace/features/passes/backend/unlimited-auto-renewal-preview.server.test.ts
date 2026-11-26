import { expect, test } from "bun:test";
import { isUnlimitedAutoRenewalPreviewEnabled } from "./unlimited-auto-renewal-preview.server";

const preview = {
  VERCEL_ENV: "preview",
  NEXI_API_ORIGIN: "https://xpaysandbox.nexigroup.com/",
  WORKSPACE_RUNTIME_HOST: undefined,
  WORKSPACE_PAYMENT_PROVIDER: undefined,
  UNLIMITED_AUTO_RENEWAL_PREVIEW: "true",
} as const;

test("exposes the renewal agreement only in an opted-in Workspace sandbox preview", () => {
  expect(isUnlimitedAutoRenewalPreviewEnabled(preview)).toBe(true);
  for (const overrides of [
    { VERCEL_ENV: "production" },
    { VERCEL_ENV: "development" },
    { UNLIMITED_AUTO_RENEWAL_PREVIEW: undefined },
    { UNLIMITED_AUTO_RENEWAL_PREVIEW: "false" },
    { WORKSPACE_RUNTIME_HOST: "container" },
    { WORKSPACE_PAYMENT_PROVIDER: "mock" },
    { WORKSPACE_PAYMENT_PROVIDER: "fallback" },
    { NEXI_API_ORIGIN: "https://xpay.nexigroup.com" },
  ] as const) {
    expect(
      isUnlimitedAutoRenewalPreviewEnabled({ ...preview, ...overrides })
    ).toBe(false);
  }
});
