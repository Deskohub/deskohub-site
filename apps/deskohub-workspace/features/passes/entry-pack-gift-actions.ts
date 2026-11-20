"use server";

import { Effect, Layer, Schema } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { WorkspaceDatabaseAdvisoryLock } from "@/db/postgres-advisory-lock";
import { WorkspaceLockSections } from "@/db/workspace-locks";
import { CurrentCustomerAccount } from "@/features/account/backend/current-customer-account";
import { CustomerAccountSections } from "@/features/account/backend/customer-account-sections";
import { type Locale, locales } from "@/features/i18n";
import { type OrderId, orderIdSchema } from "@/features/order";
import { defineWorkspaceAction } from "@/shared/backend/workspace-action";
import { CoworkPassesReleaseGate } from "./backend/cowork-passes-release-gate.server";
import { queueEntryPackGiftResend } from "./backend/entry-pack-gift";

const resendAction = defineWorkspaceAction(
  {
    operation: "passes.resend-entry-pack-invitation",
    schema: Schema.toStandardSchemaV1(
      Schema.Struct({
        orderId: orderIdSchema,
        locale: Schema.Literals(locales),
      })
    ),
    logInput: false,
  },
  Effect.fn("resendEntryPackInvitation")(
    function* ({ orderId }: { readonly orderId: OrderId }) {
      const gate = yield* CoworkPassesReleaseGate;
      if (!(yield* gate.isOpen)) return "unavailable" as const;
      const account = yield* CurrentCustomerAccount;
      const standing = yield* account.peek;
      if (
        (standing.kind !== "linked" && standing.kind !== "unlinked") ||
        standing.reviewMarker !== "absent"
      ) {
        return "unavailable" as const;
      }
      const { accountId } = standing.session;
      const sections = yield* CustomerAccountSections;
      const queued = yield* sections.withActiveAccount(
        accountId,
        queueEntryPackGiftResend(orderId, accountId).pipe(
          WorkspaceLockSections.passPurchaseFulfillment(orderId)
        )
      );
      return queued ? ("queued" as const) : ("unavailable" as const);
    },
    (effect) =>
      effect.pipe(
        Effect.provide(
          Layer.mergeAll(
            CoworkPassesReleaseGate.Live,
            CurrentCustomerAccount.Live,
            CustomerAccountSections.Live,
            WorkspaceDatabase.Default,
            WorkspaceDatabaseAdvisoryLock.Default
          )
        )
      )
  )
);

export async function resendEntryPackInvitation(
  orderId: OrderId,
  locale: Locale
): Promise<"queued" | "unavailable"> {
  const result = await resendAction({ orderId, locale });
  return result?.data ?? "unavailable";
}
