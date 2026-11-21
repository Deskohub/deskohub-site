import { Match } from "effect";
import { Suspense } from "react";
import { AdministrationCustomerDetail } from "@/features/administration/customer-detail";
import { getAdministrationCustomerName } from "@/features/administration/customer-presentation";
import { m } from "@/features/administration/i18n";
import { AdministrationRouteLoading } from "@/features/administration/loading";
import {
  loadAdministrationCustomer,
  loadAdministrationCustomerActivity,
  loadAdministrationCustomerReservationActivity,
} from "@/features/administration/page-data.server";
import { requireDotyposCustomerRouteId } from "@/features/administration/route-identifiers.server";
import { renderCustomerDiscountSlots } from "@/features/discounts/admin/customer-admin-components";
import { toAdminDotyposCustomer } from "@/features/discounts/admin/discount-administration-reads";
import {
  type DiscountAdminSearchParams,
  loadDiscountCustomerSections,
} from "@/features/discounts/admin/page-data.server";
import { getRequestLocale } from "@/features/i18n/server/request-locale";
import { AdminCustomerPasses } from "@/features/passes/admin/customer-passes";
import {
  loadAdminCustomerPasses,
  loadReservationPassLinks,
} from "@/features/passes/admin/pass-page-data.server";
import { currencyCZK } from "@/shared/money/currencies";
import { formatMoney } from "@/shared/money/money";

export default function AdministrationCustomerDetailPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly customerId: string }>;
  readonly searchParams: DiscountAdminSearchParams;
}) {
  return (
    <Suspense fallback={<AdministrationRouteLoading />}>
      <AdministrationCustomerDetailContent
        params={params}
        searchParams={searchParams}
      />
    </Suspense>
  );
}

export async function AdministrationCustomerDetailContent({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly customerId: string }>;
  readonly searchParams: DiscountAdminSearchParams;
}) {
  const { customerId: routeCustomerId } = await params;
  const locale = await getRequestLocale();
  const customerId = requireDotyposCustomerRouteId(routeCustomerId);
  const [lookup, discounts, activity, reservationActivity] = await Promise.all([
    loadAdministrationCustomer(customerId),
    loadDiscountCustomerSections(customerId, searchParams),
    loadAdministrationCustomerActivity(customerId),
    loadAdministrationCustomerReservationActivity(customerId),
  ]);
  // The full layout needs both the customer and the discount sections.
  const profile = Match.value(lookup).pipe(
    Match.discriminatorsExhaustive("kind")({
      found: ({ customer, readAt }) =>
        discounts.sections && {
          customer: toAdminDotyposCustomer(customer, readAt),
          ...discounts.sections,
        },
      absent: () => null,
      unavailable: () => null,
    })
  );

  const [passes, reservationPassLinks] = profile
    ? await Promise.all([
        loadAdminCustomerPasses(customerId),
        loadReservationPassLinks(activity.reservations.map(({ id }) => id)),
      ])
    : [null, undefined];

  return (
    <AdministrationCustomerDetail
      activity={activity}
      customerId={customerId}
      locale={locale}
      notice={discounts.notice}
      passes={
        profile && passes
          ? {
              spent: {
                label: m.passesSpent({}, { locale }),
                value: (passes.spent.length ? passes.spent : [currencyCZK(0)])
                  .map((total) => formatMoney(total, locale))
                  .join(" + "),
              },
              content: (
                <AdminCustomerPasses
                  boughtForOthers={passes.boughtForOthers}
                  held={passes.held}
                  locale={locale}
                  name={getAdministrationCustomerName(profile.customer, locale)}
                />
              ),
            }
          : undefined
      }
      profile={
        profile && {
          customer: profile.customer,
          discounts: renderCustomerDiscountSlots({ locale, profile }),
        }
      }
      reservationActivity={reservationActivity}
      reservationPassLinks={reservationPassLinks}
    />
  );
}
