import { expect, test } from "bun:test";
import { Schema } from "effect";
import { deploymentStageSchema } from "@/shared/deployment/deployment-stage";
import { selectDeploymentStageSetting } from "@/shared/deployment/deployment-stage-setting";
import { isUnlimitedAutoRenewalPreviewEnabled } from "./unlimited-auto-renewal-preview.server";

const preview = {
  VERCEL_ENV: "preview",
  NEXI_API_ORIGIN: "https://xpaysandbox.nexigroup.com/",
  NEXI_CHECKOUT_CURRENCY_OVERRIDE: "EUR",
  WORKSPACE_RUNTIME_HOST: undefined,
  WORKSPACE_PAYMENT_PROVIDER: undefined,
  UNLIMITED_AUTO_RENEWAL_PREVIEW: "true",
} as const;

test("exposes the renewal agreement only in an opted-in Workspace sandbox preview", () => {
  expect(isUnlimitedAutoRenewalPreviewEnabled(preview, "preview")).toBe(true);
  for (const overrides of [
    { VERCEL_ENV: "production" },
    { VERCEL_ENV: "development" },
    { UNLIMITED_AUTO_RENEWAL_PREVIEW: undefined },
    { UNLIMITED_AUTO_RENEWAL_PREVIEW: "false" },
    { WORKSPACE_RUNTIME_HOST: "container" },
    { WORKSPACE_PAYMENT_PROVIDER: "mock" },
    { WORKSPACE_PAYMENT_PROVIDER: "fallback" },
    { NEXI_API_ORIGIN: "https://xpay.nexigroup.com" },
    { NEXI_CHECKOUT_CURRENCY_OVERRIDE: undefined },
  ] as const) {
    expect(
      isUnlimitedAutoRenewalPreviewEnabled(
        { ...preview, ...overrides },
        "preview"
      )
    ).toBe(false);
  }
});

test("a Workspace stage override cannot open the draft on a Vercel production host", () => {
  const vercelStage = "production";
  const effectiveStage = Schema.decodeUnknownSync(deploymentStageSchema)(
    selectDeploymentStageSetting({
      VERCEL_ENV: vercelStage,
      WORKSPACE_DEPLOYMENT_STAGE: "preview",
    })
  );
  expect(effectiveStage).toBe("preview");
  expect(
    isUnlimitedAutoRenewalPreviewEnabled(
      { ...preview, VERCEL_ENV: effectiveStage },
      vercelStage
    )
  ).toBe(false);
});
