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
  getUnlimitedPassChoosePath,
  getUnlimitedPassDetailsPath,
  getUnlimitedPassPayPath,
  readUnlimitedPassSelection,
  type UnlimitedPassOrderLink,
} from "@/features/passes/unlimited-pass-checkout";
import { createNoindexedPageMetadata } from "@/features/public-pages/page-metadata";
import { reservationStatusPath } from "@/features/reservation/routes";
import { getWorkspaceAvailabilityRange } from "@/features/reservation/workspace-availability";
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
  readonly supersedeOrder?: string | string[];
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

function readOrderLink(query: Query): UnlimitedPassOrderLink | undefined {
  if (query.order !== undefined && query.supersedeOrder !== undefined)
    notFound();
  if (query.supersedeOrder !== undefined && query.step === "pay") notFound();
  const orderId = query.order ?? query.supersedeOrder;
  if (orderId === undefined) return undefined;
  if (!Schema.is(orderIdSchema)(orderId)) notFound();
  return { kind: query.order !== undefined ? "resume" : "replace", orderId };
}

async function requirePageOpen(searchParams: Promise<Query>) {
  if (await isCoworkPassesPageOpenAfterConnection()) return;
  const order = readOrderLink(await searchParams);
  if (order) await leaveUnavailableOrder(order.orderId);
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
  const order = readOrderLink(query);
  const orderId = order?.orderId;
  const isRetry = order?.kind === "resume" && query.step === "pay";
  const { options, startDate } = readUnlimitedPassSelection(query);
  const requestedSelection = startDate && { ...options, startDate };
  const checkoutPath = (
    targetLocale: Locale,
    selection: typeof requestedSelection = requestedSelection
  ) => {
    if (isRetry && orderId)
      return getUnlimitedPassPayPath(targetLocale, orderId);
    if (query.step === "details" && selection) {
      return getUnlimitedPassDetailsPath(targetLocale, selection, order);
    }
    return getUnlimitedPassChoosePath(
      targetLocale,
      selection ?? options,
      selection?.startDate,
      order
    );
  };
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
    redirect(getAccountSignInPath(locale, checkoutPath(locale)));
  }
  if (orderId && !continuation) await leaveUnavailableOrder(orderId);

  const selection =
    order?.kind === "resume" ? continuation?.selection : requestedSelection;
  if (orderId && continuation) {
    if (isRetry && !continuation.retryPayment) {
      redirect(`/${continuation.locale}${reservationStatusPath}/${orderId}`);
    }
    if (continuation.locale !== locale) {
      redirect(checkoutPath(continuation.locale, selection));
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
        initialOptions={selection ?? options}
        initialStartDate={selection?.startDate}
        initialDetails={query.step === "details" ? selection : undefined}
        initialBounds={{
          today,
          lastStartDate: plainDateStringSchema.make(
            getWorkspaceAvailabilityRange(today).to
          ),
        }}
        draft={
          order &&
          continuation && {
            ...order,
            holderEmail: continuation.holderEmail ?? undefined,
          }
        }
        retryPayment={
          orderId && isRetry && continuation?.retryPayment
            ? {
                orderId,
                selection: continuation.selection,
                state: {
                  ...continuation.retryPayment,
                  holderEmail: continuation.holderEmail ?? undefined,
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
