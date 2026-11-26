"use client";

import { useRouter } from "next/navigation";
import type { AccountUnlimitedAutoRenewal } from "@/features/account/account-unlimited-passes.server";
import { cancelAccountUnlimitedAutoRenewal } from "@/features/account/unlimited-auto-renewal-actions";
import { type Locale, m } from "@/features/i18n";
import type { OrderId } from "@/features/order";
import { Button } from "@/shared/components/ui/button";
import { useWorkspaceAction } from "@/shared/utils/use-workspace-action";

export function AccountUnlimitedAutoRenewalControls({
  autoRenewal,
  locale,
  orderId,
}: {
  readonly autoRenewal: AccountUnlimitedAutoRenewal;
  readonly locale: Locale;
  readonly orderId: OrderId;
}) {
  const router = useRouter();
  const { execute, hasErrored, isPending, result } = useWorkspaceAction(
    cancelAccountUnlimitedAutoRenewal,
    {
      onSuccess: ({ data }) => {
        if (data.status === "cancelled") router.refresh();
      },
    }
  );
  const pendingRenewal =
    autoRenewal.status === "pending" && result.data?.status !== "cancelled"
      ? autoRenewal
      : undefined;
  const failed = hasErrored || result.data?.status === "unavailable";

  return (
    <div className="space-y-3 border-t border-slate-200 px-5 py-4 @xl:px-6">
      <h5 className="font-semibold">
        {m.accountUnlimitedAutoRenewalTitle({}, { locale })}
      </h5>
      <div className="space-y-1 text-sm" role="status">
        {pendingRenewal ? (
          <p className="font-semibold">
            {m.accountUnlimitedAutoRenewalPlan(
              {
                date: pendingRenewal.nextRenewalOn,
                amount: pendingRenewal.amount,
              },
              { locale }
            )}
          </p>
        ) : (
          <p className="font-semibold">
            {m.accountUnlimitedAutoRenewalStopped({}, { locale })}
          </p>
        )}
      </div>
      <div>
        <p className="text-sm text-slate-600">
          {m.accountUnlimitedAutoRenewalScope({}, { locale })}
        </p>
        {pendingRenewal && (
          <Button
            className="mt-3"
            onClick={() => execute({ orderId })}
            pending={isPending}
            size="sm"
            type="button"
            variant="secondary"
            wrap
          >
            {m.accountUnlimitedAutoRenewalCancel({}, { locale })}
          </Button>
        )}
        <div className="text-sm text-red-700 [&:not(:empty)]:mt-2" role="alert">
          {pendingRenewal &&
            !isPending &&
            failed &&
            (result.serverError ??
              m.accountUnlimitedAutoRenewalError({}, { locale }))}
        </div>
      </div>
    </div>
  );
}
