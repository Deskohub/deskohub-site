"use server";

import { Effect, Layer, Schema } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { accountActionError } from "@/features/account/account-action-guards";
import { CustomerAccountSections } from "@/features/account/backend/customer-account-sections";
import { CustomerAuthentication } from "@/features/account/backend/customer-authentication.service";
import { requireVerifiedSession } from "@/features/account/backend/verified-customer-session";
import { m } from "@/features/i18n";
import { type OrderId, orderIdSchema } from "@/features/order";
import { CoworkPassesReleaseGate } from "@/features/passes/backend/cowork-passes-release-gate";
import { CoworkPassesReleaseGateRequest } from "@/features/passes/backend/cowork-passes-release-gate.server";
import { cancelUnlimitedAutoRenewal } from "@/features/passes/backend/unlimited-auto-renewal-management";
import { isUnlimitedAutoRenewalPreviewEnabled } from "@/features/passes/backend/unlimited-auto-renewal-preview.server";
import { defineWorkspaceAction } from "@/shared/backend/workspace-action";

const requestUnlimitedAutoRenewalCancellation = Effect.fn(
  "requestUnlimitedAutoRenewalCancellation"
)(function* (orderId: OrderId) {
  if (
    !isUnlimitedAutoRenewalPreviewEnabled() ||
    !(yield* CoworkPassesReleaseGate.isOpen)
  ) {
    return { status: "unavailable" as const };
  }
  const { accountId } = yield* requireVerifiedSession;
  const status = yield* cancelUnlimitedAutoRenewal(accountId, orderId);
  return { status };
});

const cancelAccountUnlimitedAutoRenewalAction = defineWorkspaceAction(
  {
    operation: "account.cancel-unlimited-auto-renewal",
    schema: Schema.toStandardSchemaV1(
      Schema.Struct({ orderId: orderIdSchema }),
      {
        parseOptions: { onExcessProperty: "error" },
      }
    ),
    fallback: m.accountUnlimitedAutoRenewalError,
    logInput: false,
  },
  ({ orderId }, { locale }) =>
    requestUnlimitedAutoRenewalCancellation(orderId).pipe(
      Effect.catchTag("CustomerAccountAccessError", (error) =>
        Effect.fail(accountActionError(locale)(error))
      ),
      Effect.provide(
        Layer.mergeAll(
          WorkspaceDatabase.Default,
          CustomerAccountSections.ForProvidedAuthentication,
          CoworkPassesReleaseGateRequest
        ).pipe(Layer.provideMerge(CustomerAuthentication.Default))
      )
    )
);

export const cancelAccountUnlimitedAutoRenewal: typeof cancelAccountUnlimitedAutoRenewalAction =
  async (
    ...args: Parameters<typeof cancelAccountUnlimitedAutoRenewalAction>
  ) => {
    "use server";
    return await cancelAccountUnlimitedAutoRenewalAction(...args);
  };
