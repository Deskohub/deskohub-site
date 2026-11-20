import { Effect, Layer, Schema } from "effect";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { cache, Suspense } from "react";
import { WorkspaceDatabase } from "@/db/database.service";
import { CurrentCustomerAccount } from "@/features/account/backend/current-customer-account";
import { CustomerAccountContactService } from "@/features/account/backend/customer-account-contact.service";
import { getAccountSignInPath } from "@/features/account/routes";
import { getDiscountCodeEntryEnabled } from "@/features/discounts/discount-code-entry.server";
import { type Locale, m } from "@/features/i18n";
import { runWithRequestLocale } from "@/features/i18n/server/request-locale";
import { type OrderId, orderIdSchema } from "@/features/order";
import { isCoworkPassesPageOpenAfterConnection } from "@/features/passes/backend/cowork-passes-release-gate.server";
import { readOwnedPassPurchaseOrderLocale } from "@/features/passes/backend/entry-pack-order";
import { readPassPurchaseBuyer } from "@/features/passes/backend/pass-purchase-buyer";
import { unlimitedStartRangeMaxDays } from "@/features/passes/backend/unlimited-pass-capacity";
import { loadUnlimitedCheckoutContinuation } from "@/features/passes/backend/unlimited-pass-purchase";
import { UnlimitedPassCheckout } from "@/features/passes/components/unlimited-pass-checkout";
import { unlimitedPassDays } from "@/features/passes/pass-offer";
import {
  beginUnlimitedCheckout,
  getUnlimitedCheckoutAvailability,
  payUnlimitedCheckout,
  repriceUnlimitedCheckout,
} from "@/features/passes/unlimited-checkout-actions";
import {
  getUnlimitedPassDetailsPath,
  getUnlimitedPassPayPath,
  readUnlimitedPassSelection,
} from "@/features/passes/unlimited-pass-checkout";
import { createNoindexedPageMetadata } from "@/features/public-pages/page-metadata";
import { reservationStatusPath } from "@/features/reservation/routes";
import { runWorkspaceEffectOrElse } from "@/shared/backend/workspace-effect";
import { QueryProvider } from "@/shared/components/query-provider";
import { workspaceSiteConstants } from "@/shared/utils";
import { formatCount } from "@/shared/utils/number";
import {
  currentInstant,
  plainDateStringSchema,
  temporalInstantToPlainDate,
} from "@/shared/utils/temporal";

export const instant = false;
export const maxDuration = 240;

type Query = Parameters<typeof readUnlimitedPassSelection>[0] & {
  readonly step?: string | string[];
  readonly order?: string | string[];
};

const customerServices = Layer.mergeAll(
  WorkspaceDatabase.Default,
  CurrentCustomerAccount.Live,
  CustomerAccountContactService.Live
);

const readContinuation = cache((orderId: OrderId, retry: boolean) =>
  loadUnlimitedCheckoutContinuation(orderId, retry).pipe(
    Effect.provide(customerServices),
    runWorkspaceEffectOrElse("passes.unlimited-checkout-continuation", {
      failureCode: "unlimited_checkout_unavailable",
      orElse: () => undefined,
    })
  )
);

const readOwnedLocale = cache((orderId: OrderId) =>
  readOwnedPassPurchaseOrderLocale(orderId, "unlimited").pipe(
    Effect.provide(customerServices),
    runWorkspaceEffectOrElse("passes.unlimited-checkout-order-locale", {
      failureCode: "unlimited_checkout_unavailable",
      orElse: () => undefined,
    })
  )
);

async function leaveUnavailableOrder(orderId: OrderId): Promise<never> {
  const locale = await readOwnedLocale(orderId);
  if (locale) redirect(`/${locale}${reservationStatusPath}/${orderId}`);
  notFound();
}

async function requirePageOpen(searchParams: Promise<Query>) {
  if (await isCoworkPassesPageOpenAfterConnection()) return;
  const { order } = await searchParams;
  if (Schema.is(orderIdSchema)(order)) await leaveUnavailableOrder(order);
  notFound();
}

export async function generateMetadata({
  searchParams,
}: {
  readonly searchParams: Promise<Query>;
}): Promise<Metadata> {
  return runWithRequestLocale(async (locale) => {
    await requirePageOpen(searchParams);
    return createNoindexedPageMetadata({
      locale,
      title: { page: m.unlimitedPassCheckoutTitle({}, { locale }) },
      description: m.unlimitedPassCheckoutMetadataDescription(
        { days: formatCount(unlimitedPassDays, locale) },
        { locale }
      ),
    });
  });
}

export default async function UnlimitedPassPage({
  searchParams,
}: {
  readonly searchParams: Promise<Query>;
}) {
  return runWithRequestLocale(async (locale) => {
    await requirePageOpen(searchParams);
    return (
      <Suspense fallback={null}>
        <UnlimitedPassPageContent searchParams={searchParams} locale={locale} />
      </Suspense>
    );
  });
}

async function UnlimitedPassPageContent({
  searchParams,
  locale,
}: {
  readonly searchParams: Promise<Query>;
  readonly locale: Locale;
}) {
  const query = await searchParams;
  const orderId = Schema.is(orderIdSchema)(query.order)
    ? query.order
    : undefined;
  if (query.order !== undefined && orderId === undefined) notFound();

  const isRetry = orderId !== undefined && query.step === "pay";
  const { options, startDate } = readUnlimitedPassSelection(query);
  const requestedSelection = startDate && { ...options, startDate };
  const [checkout, continuation] = await Promise.all([
    Effect.all({
      buyer: readPassPurchaseBuyer(),
      discountCodeEntryEnabled: getDiscountCodeEntryEnabled.pipe(
        Effect.orElseSucceed(() => false)
      ),
    }).pipe(
      Effect.provide(customerServices),
      runWorkspaceEffectOrElse("passes.unlimited-checkout-page", {
        failureCode: "unlimited_checkout_unavailable",
        orElse: () => ({
          buyer: { kind: "unavailable" as const },
          discountCodeEntryEnabled: false,
        }),
      })
    ),
    orderId && readContinuation(orderId, isRetry),
  ]);
  if (orderId && checkout.buyer.kind === "signed-out") {
    const path = isRetry
      ? getUnlimitedPassPayPath(locale, orderId)
      : requestedSelection &&
        getUnlimitedPassDetailsPath(locale, requestedSelection, orderId);
    if (path) redirect(getAccountSignInPath(locale, path));
  }
  if (orderId && !continuation) await leaveUnavailableOrder(orderId);
  if (orderId && continuation) {
    if (isRetry && !continuation.retryPayment) {
      redirect(`/${continuation.locale}${reservationStatusPath}/${orderId}`);
    }
    if (continuation.locale !== locale) {
      redirect(
        isRetry
          ? getUnlimitedPassPayPath(continuation.locale, orderId)
          : getUnlimitedPassDetailsPath(
              continuation.locale,
              continuation.selection,
              orderId
            )
      );
    }
  }

  const today = temporalInstantToPlainDate({
    instant: currentInstant(),
    timeZone: workspaceSiteConstants.location.timeZone,
  });

  return (
    <QueryProvider>
      <UnlimitedPassCheckout
        locale={locale}
        buyer={checkout.buyer}
        discountCodeEntryEnabled={checkout.discountCodeEntryEnabled}
        initialOptions={continuation?.selection ?? options}
        initialStartDate={continuation?.selection.startDate ?? startDate}
        initialDetails={
          continuation?.selection ??
          (query.step === "details" ? requestedSelection : undefined)
        }
        initialBounds={{
          today,
          lastStartDate: plainDateStringSchema.make(
            Temporal.PlainDate.from(today)
              .add({ days: unlimitedStartRangeMaxDays - 1 })
              .toString()
          ),
        }}
        draft={
          orderId &&
          continuation && { orderId, holderEmail: continuation.holderEmail }
        }
        retryPayment={
          orderId && isRetry && continuation?.retryPayment
            ? {
                orderId,
                selection: continuation.selection,
                state: {
                  ...continuation.retryPayment,
                  holderEmail: continuation.holderEmail,
                },
              }
            : undefined
        }
        getAvailability={getUnlimitedCheckoutAvailability}
        beginCheckout={beginUnlimitedCheckout}
        repriceCheckout={repriceUnlimitedCheckout}
        payCheckout={payUnlimitedCheckout}
      />
    </QueryProvider>
  );
}
