import "server-only";

import { and, eq } from "drizzle-orm";
import { Effect, Layer, Option } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { orders, passPurchases, paymentAttempts } from "@/db/schema";
import { CurrentCustomerAccount } from "@/features/account/backend/current-customer-account";
import { findPurchaseLoginEmail } from "@/features/account/backend/customer-account-by-email";
import type { CustomerAccountId } from "@/features/account/customer-account";
import {
  decidePaymentPageReopening,
  getPaymentPageToReopen,
} from "@/features/checkout/backend/checkout/reusable-payment-attempt";
import { LatePaymentVerificationService } from "@/features/checkout/backend/payment/late-payment-verification.service";
import { ProviderPaymentFinalizationService } from "@/features/checkout/backend/payment/provider-payment-finalization.service";
import { WorkspaceFeatureFlagService } from "@/features/feature-flags/backend/workspace-feature-flag.service";
import { isEndedUnpaidPaymentState, type OrderId } from "@/features/order";
import { runWorkspaceEffect } from "@/shared/backend/workspace-effect";
import { withWorkspaceRequestContext } from "@/shared/backend/workspace-request-context";
import { maskEmailAddress } from "@/shared/utils";
import { currentInstant } from "@/shared/utils/temporal";

const readBuyerOrder = Effect.fnUntraced(function* (
  orderId: OrderId,
  buyerAccountId: CustomerAccountId
) {
  const { db } = yield* WorkspaceDatabase;
  const [row] = yield* db
    .select({
      tier: passPurchases.tier,
      entryCount: passPurchases.entryCount,
      holderAccountId: passPurchases.holderAccountId,
      validFrom: passPurchases.validFrom,
      validUntil: passPurchases.validUntil,
      paidAt: orders.paidAt,
      paymentState: orders.paymentState,
      attempt: {
        id: paymentAttempts.id,
        provider: paymentAttempts.provider,
        state: paymentAttempts.state,
        refundState: paymentAttempts.refundState,
        providerRedirectUrl: paymentAttempts.providerRedirectUrl,
        securityToken: paymentAttempts.securityToken,
        providerOrderCreatedAt: paymentAttempts.providerOrderCreatedAt,
        createdAt: paymentAttempts.createdAt,
      },
    })
    .from(passPurchases)
    .innerJoin(orders, eq(orders.id, passPurchases.id))
    .leftJoin(
      paymentAttempts,
      and(
        eq(paymentAttempts.id, orders.activePaymentAttemptId),
        eq(paymentAttempts.orderId, orders.id)
      )
    )
    .where(
      and(
        eq(orders.kind, "pass-purchase"),
        eq(passPurchases.id, orderId),
        eq(passPurchases.buyerAccountId, buyerAccountId)
      )
    );
  return row;
});

const verificationDeadline = "40 seconds";

export const loadEntryPackStatus = Effect.fn("loadEntryPackStatus")(function* (
  orderId: OrderId
) {
  const flags = yield* WorkspaceFeatureFlagService;
  const enabled = yield* flags.isEnabled("cowork_passes").pipe(
    Effect.tapError(() =>
      Effect.logWarning("Entry pack status flag unavailable")
    ),
    Effect.orElseSucceed(() => false)
  );
  if (!enabled) return { status: "not_found" } as const;

  const account = yield* CurrentCustomerAccount;
  const session = yield* Effect.option(account.requireActive);
  if (Option.isNone(session)) {
    const standing = yield* Effect.option(account.peek);
    const kind = Option.getOrUndefined(standing)?.kind;
    return kind === "signed-out" || kind === "deletion-pending"
      ? ({ status: "sign_in" } as const)
      : ({ status: "not_found" } as const);
  }

  const { accountId } = session.value;
  const stored = yield* readBuyerOrder(orderId, accountId);
  if (!stored) return { status: "not_found" } as const;

  const { paymentState, attempt } = stored;
  let observation: "no_activity" | "unknown" | undefined;
  let checkedPayment = false;
  if (paymentState === "pending" && attempt?.provider === "nexi") {
    const finalization = yield* ProviderPaymentFinalizationService;
    const result = yield* finalization
      .finalizePendingProviderPayment({
        orderId,
        paymentAttemptId: attempt.id,
        verificationDeadline,
      })
      .pipe(
        Effect.catch(() =>
          Effect.logWarning("Entry pack payment refresh failed").pipe(
            Effect.as(undefined)
          )
        )
      );
    checkedPayment = true;
    if (result === "awaiting_payment") observation = "no_activity";
    if (result === "provider_verification_failed") observation = "unknown";
  } else if (
    isEndedUnpaidPaymentState(paymentState) &&
    attempt?.provider === "nexi" &&
    attempt.refundState === "not_required"
  ) {
    const verification = yield* LatePaymentVerificationService;
    yield* verification.startRecoveryIfSettled({
      orderId,
      verificationDeadline,
    });
    checkedPayment = true;
  }

  const row = checkedPayment
    ? yield* readBuyerOrder(orderId, accountId)
    : stored;
  if (!row) return { status: "not_found" } as const;

  const { tier, entryCount, validFrom, validUntil, paidAt } = row;
  const details = { orderId, tier, entryCount };
  if (row.paymentState === "paid" && paidAt) {
    const gift = row.holderAccountId !== accountId;
    const email = gift
      ? yield* findPurchaseLoginEmail(row.holderAccountId)
      : undefined;
    return {
      ...details,
      status: "paid",
      paidAt,
      validFrom,
      validUntil,
      gift,
      maskedHolderEmail: email ? maskEmailAddress(email) : undefined,
    } as const;
  }
  if (
    row.attempt?.refundState === "required" ||
    row.attempt?.refundState === "refunded"
  ) {
    return {
      ...details,
      status:
        row.attempt.refundState === "refunded" ? "refunded" : "refund_required",
    } as const;
  }
  if (row.paymentState === "pending") {
    const now = yield* currentInstant;
    const currentAttempt = row.attempt;
    const page =
      observation &&
      currentAttempt &&
      currentAttempt.id === attempt?.id &&
      decidePaymentPageReopening(currentAttempt, now, observation) === "open"
        ? getPaymentPageToReopen(currentAttempt, now)
        : undefined;
    return {
      ...details,
      status: "pending",
      paymentPage:
        page && "providerRedirectUrl" in page
          ? page.providerRedirectUrl
          : undefined,
    } as const;
  }
  return {
    ...details,
    status:
      row.paymentState === "cancelled" || row.paymentState === "expired"
        ? row.paymentState
        : "failed",
  } as const;
});

export type EntryPackStatus = Effect.Success<
  ReturnType<typeof loadEntryPackStatus>
>;

export const loadEntryPackStatusPage = (
  orderId: OrderId,
  requestHeaders: Headers
) =>
  loadEntryPackStatus(orderId).pipe(
    Effect.provide(
      Layer.mergeAll(
        WorkspaceDatabase.Default,
        CurrentCustomerAccount.Live,
        WorkspaceFeatureFlagService.Default,
        ProviderPaymentFinalizationService.Live,
        LatePaymentVerificationService.Live
      )
    ),
    withWorkspaceRequestContext(requestHeaders),
    runWorkspaceEffect("entryPack.status.load")
  );
