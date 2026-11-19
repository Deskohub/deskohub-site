import { Check, CircleAlert, Clock } from "lucide-react";
import Link from "next/link";
import { CheckoutFlowLayout } from "@/features/checkout/components/checkout-flow-layout";
import { type Locale, m } from "@/features/i18n";
import { RouteAutoRefresh } from "@/shared/components/route-auto-refresh";
import { Button } from "@/shared/components/ui/button";
import { workspaceSiteConstants } from "@/shared/utils";
import {
  formatInstantDateTime,
  formatPlainDateRange,
} from "@/shared/utils/date-time-format";
import type { EntryPackStatus } from "../backend/entry-pack-status";
import { getEntryPackLastUsableDate } from "../pass-offer";
import { getPassTierName } from "../pass-offer.i18n";

type OrderStatus = Exclude<
  EntryPackStatus,
  { status: "not_found" | "sign_in" }
>;

const statusTitles = {
  paid: m.passEmailSubject,
  pending: m.checkoutStatusPendingTitle,
  cancelled: m.checkoutStatusCancelledTitle,
  expired: m.checkoutStatusExpiredTitle,
  failed: m.checkoutStatusPaymentFailedTitle,
  refund_required: m.checkoutStatusLatePaymentRefundTitle,
  refunded: m.entryPackStatusRefundedTitle,
};

const statusLeads = {
  pending: m.entryPackStatusPendingLead,
  cancelled: m.entryPackStatusRetryLead,
  expired: m.entryPackStatusRetryLead,
  failed: m.entryPackStatusRetryLead,
  refund_required: m.entryPackStatusRefundLead,
  refunded: m.entryPackStatusRefundedLead,
};

const statusIcons = {
  paid: Check,
  pending: Clock,
  cancelled: CircleAlert,
  expired: CircleAlert,
  failed: CircleAlert,
  refund_required: CircleAlert,
  refunded: Check,
};

export function EntryPackStatusPage({
  allowNewPurchase,
  locale,
  status,
  presentation,
}: {
  readonly allowNewPurchase: boolean;
  readonly locale: Locale;
  readonly status: OrderStatus;
  readonly presentation: "page" | "modal";
}) {
  const isPaid = status.status === "paid";
  const isPending = status.status === "pending";
  const Icon = statusIcons[status.status];
  const title = statusTitles[status.status]({}, { locale });
  const lead = isPaid
    ? status.gift && m.passEmailGiftBody({}, { locale })
    : statusLeads[status.status]({}, { locale });
  const content = (
    <div
      className={
        presentation === "modal"
          ? "bg-white p-6 text-navy-blue sm:p-10"
          : "rounded-[2.25rem] border border-white/55 bg-white/94 p-6 text-navy-blue shadow-[0_44px_140px_-54px_rgba(0,2,79,0.62)] backdrop-blur-sm sm:p-10"
      }
      data-entry-pack-status={status.status}
    >
      <RouteAutoRefresh enabled={isPending} />
      <output className="sr-only" aria-live="polite" aria-atomic>
        {title}
      </output>
      <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
        <div className="flex size-16 shrink-0 items-center justify-center rounded-2xl bg-navy-blue/5">
          <Icon aria-hidden="true" className="size-8" />
        </div>
        <div className="min-w-0">
          <h1 className="text-balance text-4xl leading-none sm:text-5xl">
            {title}
          </h1>
          {lead && (
            <p className="mt-4 text-lg leading-8 text-navy-blue/70">{lead}</p>
          )}
        </div>
      </div>
      <div className="mt-8 rounded-2xl border border-navy-blue/10 bg-navy-blue/3 p-5 sm:p-6">
        <h2 className="text-xl font-semibold">
          {m.passEntryPack({}, { locale })}
        </h2>
        <p className="mt-1 text-navy-blue/70">
          {getPassTierName(status.tier, locale)} ·{" "}
          {m.passEntryCount({ count: status.entryCount }, { locale })}
        </p>
        {isPaid && (
          <p className="mt-1 text-sm text-navy-blue/70">
            {m.passEmailValid(
              {
                dates: formatPlainDateRange({
                  locale,
                  start: Temporal.PlainDate.from(status.validFrom),
                  end: getEntryPackLastUsableDate(status.validUntil),
                }),
              },
              { locale }
            )}
          </p>
        )}
        <dl className="mt-5 grid gap-4 border-t border-navy-blue/10 pt-4 sm:grid-cols-2">
          <div>
            <dt className="text-sm text-navy-blue/70">
              {m.checkoutSummarySectionOrder({}, { locale })}
            </dt>
            <dd className="break-all text-sm">{status.orderId}</dd>
          </div>
          {isPaid && status.maskedHolderEmail && (
            <div>
              <dt className="text-sm text-navy-blue/70">
                {m.passEmailFor({}, { locale })}
              </dt>
              <dd className="break-all text-sm">{status.maskedHolderEmail}</dd>
            </div>
          )}
          {isPaid && (
            <div>
              <dt className="text-sm text-navy-blue/70">
                {m.passEmailPaidOn({}, { locale })}
              </dt>
              <dd className="text-sm">
                {formatInstantDateTime({
                  instant: status.paidAt,
                  locale,
                  timeZone: workspaceSiteConstants.location.timeZone,
                })}
              </dd>
            </div>
          )}
        </dl>
      </div>
      <div className="mt-8 flex flex-wrap gap-3">
        {isPending && status.paymentPage && (
          <Button asChild size="lg">
            <a href={status.paymentPage}>
              {m.checkoutStatusOpenPaymentPage({}, { locale })}
            </a>
          </Button>
        )}
        {allowNewPurchase && (
          <Button asChild size="lg">
            <a href={`/${locale}/passes/entry-pack`}>
              {m.checkoutStatusTryAgain({}, { locale })}
            </a>
          </Button>
        )}
        <Button asChild size="lg" variant="secondary">
          <Link href={`/${locale}`} prefetch={false}>
            {m.checkoutStatusBackHome({}, { locale })}
          </Link>
        </Button>
      </div>
    </div>
  );
  return presentation === "modal" ? (
    content
  ) : (
    <CheckoutFlowLayout activeStepKey="complete" locale={locale} steps={false}>
      {content}
    </CheckoutFlowLayout>
  );
}
