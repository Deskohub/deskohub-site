import {
  and,
  desc,
  eq,
  gte,
  isNotNull,
  ne,
  notInArray,
  sql,
} from "drizzle-orm";
import { Context, Effect, Layer, Option, Schema } from "effect";
import {
  WorkspaceDatabase,
  type WorkspaceDatabaseClient,
  WorkspaceTransaction,
} from "@/db/database.service";
import {
  legalEvidenceEvents,
  orders,
  passPurchases,
  paymentAttempts,
  workspaceReservations,
} from "@/db/schema";
import type { CustomerAccountId } from "@/features/account/customer-account";
import { AccountingDocumentSnapshots } from "@/features/accounting/backend/accounting-document-snapshots";
import { paymentSubmitLegalEvidenceSource } from "@/features/checkout/legal-evidence";
import { m } from "@/features/i18n";
import { getConsumerWithdrawalPeriodCutoff } from "@/features/legal/early-performance";
import { type OrderId, orderIdSchema } from "@/features/order";
import {
  ContractCancellationError,
  type WithdrawableContract,
  type WithdrawableContractFamily,
  WithdrawableContractUnavailableError,
} from "@/features/withdrawal/withdrawable-contract";
import type { WithdrawalAssessment } from "@/features/withdrawal/withdrawal-assessment";
import { currencyCZK } from "@/shared/money/currencies";
import { type Money, sameMoneyUnit } from "@/shared/money/money";
import { formatPlainDateRange } from "@/shared/utils/date-time-format";
import { workspaceSiteConstants } from "@/shared/utils/site-constants";
import { type PlainDate, plainDateStringSchema } from "@/shared/utils/temporal";
import { unlimitedPassDays } from "../pass-offer";
import { getPassTierName } from "../pass-offer.i18n";
import {
  getUnlimitedPassEndDate,
  getUnlimitedPassWithdrawal,
} from "../unlimited-pass";

const kind = "unlimited-pass" as const;
const decodeOrderId = Schema.decodeOption(orderIdSchema);

const readPaidUnlimitedPass = (
  db: WorkspaceDatabaseClient,
  id: OrderId,
  buyerAccountId: CustomerAccountId
) =>
  db
    .select({
      status: passPurchases.status,
      tier: passPurchases.tier,
      validFrom: passPurchases.validFrom,
      buyerConfirmationDeliveredAt: passPurchases.buyerConfirmationDeliveredAt,
      attemptId: paymentAttempts.id,
      paidValue: paymentAttempts.amountValue,
      exponent: paymentAttempts.amountExponent,
      currency: paymentAttempts.currency,
    })
    .from(passPurchases)
    .innerJoin(orders, eq(orders.id, passPurchases.id))
    .innerJoin(
      paymentAttempts,
      and(
        eq(paymentAttempts.id, orders.activePaymentAttemptId),
        eq(paymentAttempts.orderId, orders.id),
        eq(paymentAttempts.state, "paid")
      )
    )
    .where(
      and(
        eq(passPurchases.id, id),
        eq(passPurchases.product, "unlimited"),
        eq(passPurchases.buyerAccountId, buyerAccountId),
        eq(orders.kind, "pass-purchase"),
        eq(orders.paymentState, "paid")
      )
    );

const paidAmountOf = (pass: {
  readonly paidValue: number;
  readonly exponent: number;
  readonly currency: string;
}): Money => ({
  value: pass.paidValue,
  exponent: pass.exponent,
  currency: pass.currency,
});

const serviceDateAt = (instant: Temporal.Instant): PlainDate =>
  plainDateStringSchema.make(
    instant
      .toZonedDateTimeISO(workspaceSiteConstants.location.timeZone)
      .toPlainDate()
      .toString()
  );

const getWithdrawalPeriodEnd = (
  deliveredAt: Temporal.Instant | null,
  at: Temporal.Instant
) =>
  deliveredAt && Temporal.Instant.compare(deliveredAt, at) <= 0
    ? getConsumerWithdrawalPeriodCutoff(deliveredAt)
    : undefined;

const assessUnlimitedPassWithdrawal = (input: {
  readonly startDate: PlainDate;
  readonly paid: Money;
  readonly periodEndsAt: Temporal.Instant;
  readonly now: Temporal.Instant;
  readonly earlyPerformanceConsent: boolean;
}): WithdrawalAssessment => {
  const { startDate, paid, periodEndsAt, now } = input;
  if (Temporal.Instant.compare(now, periodEndsAt) >= 0) {
    return { withdrawable: false, reason: "period_ended" };
  }
  const { accessEndsOn, refund } = getUnlimitedPassWithdrawal({
    startDate,
    withdrawalDate: serviceDateAt(now),
    paid,
  });
  const unstarted = Temporal.PlainDate.from(accessEndsOn).until(
    getUnlimitedPassEndDate(startDate)
  ).days;
  if (unstarted === 0) {
    return { withdrawable: false, reason: "performance_started" };
  }
  if (unstarted < unlimitedPassDays && !input.earlyPerformanceConsent) {
    return { withdrawable: false, reason: "not_withdrawable" };
  }
  return {
    withdrawable: true,
    refundAmount: refund,
    refundBasis:
      unstarted === unlimitedPassDays
        ? { kind: "full" }
        : { kind: "partial", unit: "day", unstarted, total: unlimitedPassDays },
    periodEndsAt,
  };
};

export const lockUnlimitedPassOrderForWithdrawal = Effect.fn(
  "lockUnlimitedPassOrderForWithdrawal"
)(function* (contractId: string) {
  const id = decodeOrderId(contractId);
  if (Option.isNone(id)) return undefined;
  const { db } = yield* WorkspaceTransaction;
  const [order] = yield* db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.id, id.value), eq(orders.kind, "pass-purchase")))
    .for("no key update");
  return order?.id;
});

/** The cutoff and refund obligation commit with the buyer's statement. */
export const recordUnlimitedPassWithdrawal = Effect.fn(
  "recordUnlimitedPassWithdrawal"
)(function* (input: {
  readonly orderId: OrderId;
  readonly accountId: CustomerAccountId;
  readonly submittedAt: Temporal.Instant;
  readonly paidAmount: Money;
  readonly refundAmount: Money;
}) {
  const { db } = yield* WorkspaceTransaction;
  const [pass] = yield* readPaidUnlimitedPass(
    db,
    input.orderId,
    input.accountId
  ).for("no key update", { of: passPurchases });
  if (pass?.status !== "active") return;
  const periodEndsAt = getWithdrawalPeriodEnd(
    pass.buyerConfirmationDeliveredAt,
    input.submittedAt
  );
  if (
    !periodEndsAt ||
    Temporal.Instant.compare(input.submittedAt, periodEndsAt) >= 0
  ) {
    return;
  }
  const paid = paidAmountOf(pass);
  if (
    !sameMoneyUnit(paid, currencyCZK(0)) ||
    !sameMoneyUnit(paid, input.paidAmount) ||
    paid.value !== input.paidAmount.value
  ) {
    return;
  }
  const { accessEndsOn, refund } = getUnlimitedPassWithdrawal({
    startDate: pass.validFrom,
    withdrawalDate: serviceDateAt(input.submittedAt),
    paid,
  });
  if (
    accessEndsOn === getUnlimitedPassEndDate(pass.validFrom) ||
    !sameMoneyUnit(refund, input.refundAmount) ||
    refund.value !== input.refundAmount.value
  ) {
    return;
  }
  yield* db
    .update(passPurchases)
    .set({ status: "withdrawn", accessEndsOn })
    .where(eq(passPurchases.id, input.orderId));
  if (refund.value > 0) {
    // A separate refund obligation on the same payment may already be larger.
    const target = sql`case
      when ${paymentAttempts.refundState} = 'required' and ${paymentAttempts.refundTargetValue} is null
      then ${paymentAttempts.amountValue}
      else greatest(coalesce(${paymentAttempts.refundTargetValue}, 0), ${refund.value})
    end`;
    yield* db
      .update(paymentAttempts)
      .set({
        refundState: sql`case when ${paymentAttempts.refundedAmountValue} >= ${target} then 'refunded' else 'required' end`,
        refundTargetValue: target,
        updatedAt: input.submittedAt,
      })
      .where(
        and(
          eq(paymentAttempts.id, pass.attemptId),
          ne(paymentAttempts.provider, "internal")
        )
      );
  }
  return periodEndsAt;
});

export class UnlimitedPassWithdrawals extends Context.Service<
  UnlimitedPassWithdrawals,
  WithdrawableContractFamily
>()("@deskohub-workspace/passes/UnlimitedPassWithdrawals") {
  static Default = Layer.effect(
    this,
    Effect.gen(function* () {
      const { db } = yield* WorkspaceDatabase;
      const snapshots = yield* AccountingDocumentSnapshots;
      return {
        kind,
        find: Effect.fn("UnlimitedPassWithdrawals.find")(
          function* ({ contractId, accountId, locale }) {
            const id = decodeOrderId(contractId);
            if (Option.isNone(id)) return Option.none();
            const [pass] = yield* readPaidUnlimitedPass(
              db,
              id.value,
              accountId
            );
            if (!pass) return Option.none();
            const paid = paidAmountOf(pass);
            if (!sameMoneyUnit(paid, currencyCZK(0))) return Option.none();
            const snapshot = yield* snapshots.findPassPurchase(pass.attemptId);
            if (
              snapshot?.orderId !== id.value ||
              snapshot.product.kind !== "unlimited"
            ) {
              return Option.none();
            }
            const business = snapshot.billing.purpose === "business";
            const [terms] = yield* db
              .select({
                acknowledgements: legalEvidenceEvents.acknowledgements,
              })
              .from(legalEvidenceEvents)
              .where(
                and(
                  eq(legalEvidenceEvents.orderId, id.value),
                  eq(legalEvidenceEvents.documentKey, "termsAndConditions"),
                  eq(
                    legalEvidenceEvents.source,
                    paymentSubmitLegalEvidenceSource
                  ),
                  eq(legalEvidenceEvents.accepted, true)
                )
              )
              .orderBy(desc(legalEvidenceEvents.acceptedAt))
              .limit(1);
            if (!terms) return Option.none();
            const earlyPerformanceConsent =
              terms.acknowledgements?.earlyPerformanceConsent === true &&
              terms.acknowledgements.unlimitedPassEarlyStartRequested === true;
            const start = Temporal.PlainDate.from(pass.validFrom);
            const dates = formatPlainDateRange({
              locale,
              start,
              end: start.add({ days: unlimitedPassDays - 1 }),
            });
            return Option.some<WithdrawableContract>({
              ref: { kind, id: id.value },
              label: [
                m.passUnlimited({}, { locale }),
                getPassTierName(pass.tier, locale),
                dates,
              ].join(" · "),
              paidAmount: paid,
              assess: (now) => {
                if (pass.status !== "active") {
                  return { withdrawable: false, reason: "not_withdrawable" };
                }
                if (business) {
                  return { withdrawable: false, reason: "business_purpose" };
                }
                const periodEndsAt = getWithdrawalPeriodEnd(
                  pass.buyerConfirmationDeliveredAt,
                  now
                );
                if (!periodEndsAt) {
                  return { withdrawable: false, reason: "not_withdrawable" };
                }
                return assessUnlimitedPassWithdrawal({
                  startDate: pass.validFrom,
                  paid,
                  periodEndsAt,
                  now,
                  earlyPerformanceConsent,
                });
              },
            });
          },
          Effect.mapError(
            (cause) =>
              new WithdrawableContractUnavailableError({
                kind,
                message:
                  "The Unlimited pass could not be read for a withdrawal.",
                cause,
              })
          )
        ),
        cancel: Effect.fn("UnlimitedPassWithdrawals.cancel")(function* ({
          contractId,
        }) {
          const id = decodeOrderId(contractId);
          if (Option.isNone(id)) {
            return yield* new ContractCancellationError({
              kind,
              code: "unlimited_pass_invalid_id",
              transient: false,
              message: "The withdrawn Unlimited pass id is invalid.",
            });
          }
          const pendingDays = db
            .select({ id: workspaceReservations.id })
            .from(workspaceReservations)
            .where(
              and(
                eq(workspaceReservations.passId, passPurchases.id),
                gte(
                  workspaceReservations.serviceDate,
                  passPurchases.accessEndsOn
                ),
                // The release worker uses hold_expired when no provider hold was made.
                notInArray(workspaceReservations.reservationState, [
                  "cancelled",
                  "hold_expired",
                ])
              )
            );
          const [pass] = yield* db
            .select({ pending: sql<boolean>`exists (${pendingDays})` })
            .from(passPurchases)
            .where(
              and(
                eq(passPurchases.id, id.value),
                eq(passPurchases.product, "unlimited"),
                eq(passPurchases.status, "withdrawn"),
                isNotNull(passPurchases.accessEndsOn)
              )
            )
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ContractCancellationError({
                    kind,
                    code: "unlimited_pass_release_check_failed",
                    transient: true,
                    message:
                      "The release of withdrawn Unlimited pass days could not be checked.",
                    cause,
                  })
              )
            );
          if (!pass) {
            return yield* new ContractCancellationError({
              kind,
              code: "unlimited_pass_release_missing",
              transient: false,
              message: "The withdrawn Unlimited pass or its cutoff is missing.",
            });
          }
          if (pass.pending) {
            return yield* new ContractCancellationError({
              kind,
              code: "unlimited_pass_release_pending",
              transient: false,
              message:
                "The withdrawn Unlimited pass still has days to release.",
            });
          }
        }),
      };
    })
  );
}
