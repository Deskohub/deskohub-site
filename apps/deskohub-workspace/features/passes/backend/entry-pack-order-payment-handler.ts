import "server-only";

import { EmailConfigTag, EmailServiceTag } from "@deskohub/email";
import { and, eq } from "drizzle-orm";
import { Context, Effect } from "effect";
import { WorkspaceDatabase, WorkspaceTransaction } from "@/db/database.service";
import { orders, passPurchases, paymentAttempts } from "@/db/schema";
import { findPurchaseLoginEmail } from "@/features/account/backend/customer-account-by-email";
import type {
  AdmittingOrderPaymentHandler,
  PaymentAdmission,
} from "@/features/checkout/backend/payment/order-payment-handler";
import { toPaymentAttempt } from "@/features/checkout/backend/repositories/payment-attempt.repository";
import {
  attachPaymentProviderSession,
  insertPaymentAttempt,
  markPaymentAttemptPaid,
  markPaymentAttemptTerminal,
} from "@/features/checkout/backend/repositories/payment-attempt-writes";
import {
  persistDiscountApplications,
  reserveCommittedClaims,
  validateDiscountCommitment,
  validateInternalPaymentCommitment,
} from "@/features/checkout/backend/repositories/payment-lifecycle.repository";
import { lifecycleStateError } from "@/features/checkout/backend/repositories/payment-lifecycle-state";
import {
  type DiscountCommitment,
  getDiscountCommitmentPayload,
} from "@/features/discounts/commitment";
import { PromotionClaims } from "@/features/discounts/promotion-claims";
import { isEndedUnpaidPaymentState, type OrderId } from "@/features/order";
import { ReferralInvitationLedger } from "@/features/referrals/referral-invitation-ledger";
import { moneyEquals } from "@/shared/money/money";
import { currentInstant } from "@/shared/utils/temporal";
import { isEntryPackQuoteExpired } from "../pass-offer";
import { sendEntryPackPurchaseEmail } from "./entry-pack-purchase-email";
import { settleEntryPack } from "./entry-pack-settlement";

export type EntryPackPaymentAdmissionDetails = {
  readonly commitment: DiscountCommitment;
};

type Handler = AdmittingOrderPaymentHandler<EntryPackPaymentAdmissionDetails>;
type NexiAdmission = Parameters<Handler["admitNexi"]>[0];
type Verification = Parameters<Handler["markPaid"]>[0];
type PackOrder = typeof orders.$inferSelect;
type AttemptRow = typeof paymentAttempts.$inferSelect;

const paymentError = (orderId: OrderId, message: string) =>
  lifecycleStateError(
    "entryPackPayment",
    { type: "orderId", id: orderId },
    message
  );

const transition = (
  attempt: AttemptRow,
  changed: boolean,
  timestamp = attempt.updatedAt
) => ({ attempt: toPaymentAttempt(attempt), changed, timestamp });

const setPaid = Effect.fnUntraced(function* (
  order: PackOrder,
  attempt: AttemptRow,
  paidAt: Temporal.Instant
) {
  const { db } = yield* WorkspaceTransaction;
  yield* db
    .update(orders)
    .set({
      paymentState: "paid",
      activePaymentAttemptId: attempt.id,
      paidAt,
      updatedAt: paidAt,
    })
    .where(eq(orders.id, order.id));
  yield* settleEntryPack(order.id);
  return transition(attempt, true, paidAt);
});

const redeemClaims = Effect.fnUntraced(function* (
  order: PackOrder,
  attemptId: AttemptRow["id"],
  paidAt: Temporal.Instant,
  readmitReleased: boolean
) {
  yield* ReferralInvitationLedger.ensureFirstPaid({
    orderId: order.id,
    dotyposCustomerId: order.dotyposCustomerId,
    paymentAttemptId: attemptId,
  });
  yield* PromotionClaims.redeem({
    paymentAttemptId: attemptId,
    redeemedAt: paidAt,
    readmitReleased,
  });
  yield* ReferralInvitationLedger.redeem({
    orderId: order.id,
    paymentAttemptId: attemptId,
    redeemedAt: paidAt,
    readmitReleased,
  });
});

export const makeEntryPackOrderPaymentHandler = Effect.gen(function* () {
  const { db, transaction } = yield* WorkspaceDatabase;
  const email = yield* EmailServiceTag;
  const emailConfig = yield* EmailConfigTag;
  const services = Context.make(WorkspaceDatabase, { db, transaction });
  const sendingServices = services.pipe(
    Context.add(EmailServiceTag, email),
    Context.add(EmailConfigTag, emailConfig)
  );

  const readOrder = (orderId: OrderId) =>
    db
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.kind, "pass-purchase")));
  const readAttempt = (orderId: OrderId, id: AttemptRow["id"]) =>
    db
      .select()
      .from(paymentAttempts)
      .where(
        and(eq(paymentAttempts.orderId, orderId), eq(paymentAttempts.id, id))
      );

  // Take the buyer's referral locks before touching rows that other payment paths lock.
  const lockOrder = Effect.fnUntraced(function* (
    id: OrderId,
    records: Parameters<
      typeof ReferralInvitationLedger.lockFirstBooking
    >[0]["records"]
  ) {
    const [identity] = yield* readOrder(id);
    if (!identity)
      return yield* paymentError(id, "The Entry pack order was not found.");
    yield* ReferralInvitationLedger.lockFirstBooking({
      dotyposCustomerId: identity.dotyposCustomerId,
      records,
    });
    const [locked] = yield* readOrder(id).for("no key update");
    if (!locked)
      return yield* paymentError(id, "The Entry pack order was not found.");
    return locked;
  });

  const admit = Effect.fnUntraced(function* (
    input: PaymentAdmission<EntryPackPaymentAdmissionDetails>,
    providerOrderId?: NexiAdmission["providerOrderId"]
  ) {
    const commitment = getDiscountCommitmentPayload(input.details.commitment);
    const claims = yield* providerOrderId === undefined
      ? validateInternalPaymentCommitment(commitment, input.amount)
      : validateDiscountCommitment(commitment);
    const order = yield* lockOrder(
      input.orderId,
      providerOrderId === undefined
        ? { admittedInvitation: claims.referral !== undefined }
        : "nothing"
    );
    const [pack] = yield* db
      .select()
      .from(passPurchases)
      .where(eq(passPurchases.id, order.id));
    if (
      !pack ||
      pack.locale !== input.locale ||
      commitment.product.kind !== "entry-pack" ||
      commitment.product.tier !== pack.tier ||
      commitment.product.size !== pack.entryCount ||
      commitment.firstServiceDate !== pack.validFrom ||
      !moneyEquals(pack.quote.discountedSubtotal, input.amount)
    ) {
      return yield* paymentError(
        order.id,
        "The Entry pack price no longer matches the purchase."
      );
    }
    if (
      providerOrderId === undefined &&
      order.paymentState === "paid" &&
      order.activePaymentAttemptId
    ) {
      const [existing] = yield* readAttempt(
        order.id,
        order.activePaymentAttemptId
      );
      if (existing?.provider === "internal")
        return transition(existing, false, order.paidAt ?? existing.updatedAt);
    }
    if (
      order.paymentState !== "not_started" &&
      !isEndedUnpaidPaymentState(order.paymentState)
    ) {
      return yield* paymentError(
        order.id,
        "The Entry pack already has a payment."
      );
    }
    const now = yield* currentInstant;
    if (isEntryPackQuoteExpired(now, pack.validUntil)) {
      return yield* paymentError(
        order.id,
        "The Entry pack quote expired. Request a new quote."
      );
    }
    yield* ReferralInvitationLedger.admitFirstBooking({
      orderId: order.id,
      dotyposCustomerId: order.dotyposCustomerId,
      admitsInvitation: claims.referral !== undefined,
    }).pipe(
      Effect.catchTag("ReferralFirstBookingAdmittedError", ({ message }) =>
        Effect.fail(paymentError(order.id, message))
      )
    );

    const attempt = yield* insertPaymentAttempt({
      orderId: order.id,
      workspaceReservationId: null,
      amount: input.amount,
      ...(providerOrderId
        ? { provider: "nexi", providerOrderId }
        : { provider: "internal", paidAt: now }),
    });
    const applicationRows = yield* persistDiscountApplications({
      commitment,
      paymentAttemptId: attempt.id,
      workspaceReservationId: null,
    });
    yield* reserveCommittedClaims({
      claimedApplications: claims,
      applicationRows,
      paymentAttemptId: attempt.id,
      locale: input.locale,
      reservationCustomerId: order.dotyposCustomerId,
      reservationExpiresAt: now.add({ hours: 1 }),
      firstServiceDate: pack.validFrom,
    });
    if (!providerOrderId) {
      yield* redeemClaims(order, attempt.id, now, false);
      return yield* setPaid(order, attempt, now);
    }
    yield* db
      .update(orders)
      .set({
        activePaymentAttemptId: attempt.id,
        paymentState: "pending",
        updatedAt: now,
      })
      .where(eq(orders.id, order.id));
    if (pack.status === "void") {
      yield* db
        .update(passPurchases)
        .set({ status: "pending_payment" })
        .where(
          and(eq(passPurchases.id, order.id), eq(passPurchases.status, "void"))
        );
    }
    return transition(attempt, true, now);
  });

  const fulfill = Effect.fn("entryPack.fulfill")(function* (orderId: OrderId) {
    const [paid] = yield* db
      .select({ order: orders, purchase: passPurchases })
      .from(orders)
      .innerJoin(passPurchases, eq(orders.id, passPurchases.id))
      .where(
        and(
          eq(orders.id, orderId),
          eq(orders.paymentState, "paid"),
          eq(orders.fulfillmentState, "not_started")
        )
      );
    if (!paid) return;
    const {
      purchase,
      order: { paidAt },
    } = paid;
    if (!paidAt) return;
    const buyer = yield* findPurchaseLoginEmail(purchase.buyerAccountId).pipe(
      Effect.provide(services)
    );
    if (buyer) {
      const holderEmail =
        purchase.buyerAccountId === purchase.holderAccountId
          ? null
          : ((yield* findPurchaseLoginEmail(purchase.holderAccountId).pipe(
              Effect.provide(services)
            )) ?? null);
      yield* sendEntryPackPurchaseEmail({
        purchase,
        buyer: { email: buyer },
        holderEmail,
        paidAt,
        invoiceRequested: false,
      }).pipe(Effect.provide(sendingServices));
    }
    const now = yield* currentInstant;
    yield* db
      .update(orders)
      .set({ fulfillmentState: "fulfilled", fulfilledAt: now, updatedAt: now })
      .where(
        and(eq(orders.id, orderId), eq(orders.fulfillmentState, "not_started"))
      );
  });

  const recordLateCapture = Effect.fnUntraced(function* (
    input: Verification,
    attempt: AttemptRow,
    refundRequired: boolean
  ) {
    const [paid] = yield* db
      .update(paymentAttempts)
      .set({
        state: "paid",
        refundState: refundRequired ? "required" : "not_required",
        failureCode: null,
        lastWebhookEventId: input.webhookEventId,
        lastProviderOperationId: input.providerOperationId,
        lastProviderStatus: input.providerStatus,
        updatedAt: input.paidAt,
      })
      .where(eq(paymentAttempts.id, attempt.id))
      .returning();
    if (!paid)
      return yield* paymentError(
        input.orderId,
        "The late Entry pack attempt was not found."
      );
    return paid;
  });

  const recover = Effect.fn("entryPack.recoverPayment")(function* (
    input: Verification
  ) {
    const order = yield* lockOrder(input.orderId, { claimOf: input.id });
    const [attempt] = yield* readAttempt(order.id, input.id).for("update");
    if (attempt?.provider !== "nexi") {
      return yield* paymentError(
        order.id,
        "The late Entry pack attempt was not found."
      );
    }
    if (attempt.state === "paid")
      return (
        order.activePaymentAttemptId === attempt.id &&
        order.paymentState === "paid"
      );
    if (!isEndedUnpaidPaymentState(attempt.state)) {
      return yield* paymentError(
        order.id,
        "Only a terminal attempt can be recovered."
      );
    }

    if (
      order.activePaymentAttemptId === attempt.id &&
      isEndedUnpaidPaymentState(order.paymentState)
    ) {
      const recovered = yield* transaction(
        Effect.gen(function* () {
          yield* redeemClaims(order, attempt.id, input.paidAt, true);
          const paid = yield* recordLateCapture(input, attempt, false);
          yield* setPaid(order, paid, input.paidAt);
          return true;
        }).pipe(Effect.provide(services))
      ).pipe(
        Effect.catchTag("DiscountClaimError", () => Effect.succeed(false))
      );
      if (recovered) return true;
    }
    yield* recordLateCapture(input, attempt, true);
    return false;
  });

  return {
    load: (orderId) =>
      readOrder(orderId).pipe(
        Effect.map(([order]) =>
          order ? { ...order, logFields: { orderId } } : null
        )
      ),
    admitNexi: (input) =>
      transaction(
        admit(input, input.providerOrderId).pipe(Effect.provide(services))
      ).pipe(Effect.map(({ attempt }) => attempt)),
    admitInternal: (input) =>
      transaction(admit(input).pipe(Effect.provide(services))),
    attachProviderSession: (input) =>
      attachPaymentProviderSession(input).pipe(Effect.provide(services)),
    markPaid: (input) =>
      transaction(
        Effect.gen(function* () {
          const order = yield* lockOrder(input.orderId, { claimOf: input.id });
          const [existing] = yield* readAttempt(order.id, input.id);
          if (existing?.state === "paid")
            return transition(
              existing,
              false,
              order.paidAt ?? existing.updatedAt
            );
          if (
            order.paymentState !== "pending" ||
            order.activePaymentAttemptId !== input.id
          ) {
            return yield* paymentError(
              order.id,
              "Only the current Entry pack attempt can mark an order paid."
            );
          }
          yield* redeemClaims(order, input.id, input.paidAt, false);
          const paid = yield* markPaymentAttemptPaid(input);
          if (!paid)
            return yield* paymentError(
              order.id,
              "The Entry pack attempt is no longer pending."
            );
          return yield* setPaid(order, paid, input.paidAt);
        }).pipe(Effect.provide(services))
      ),
    markTerminal: (input) =>
      transaction(
        Effect.gen(function* () {
          const order = yield* lockOrder(input.orderId, "nothing");
          const [existing] = yield* readAttempt(order.id, input.id);
          if (!existing)
            return yield* paymentError(
              order.id,
              "The Entry pack attempt was not found."
            );
          if (
            isEndedUnpaidPaymentState(existing.state) ||
            existing.state === "paid"
          )
            return transition(existing, false);
          const terminalAt = yield* currentInstant;
          const terminal = yield* markPaymentAttemptTerminal({
            ...input,
            terminalAt,
            fromAttemptStates: input.fromAttemptStates ?? [
              "created",
              "pending",
            ],
          });
          if (!terminal) return transition(existing, false);
          yield* PromotionClaims.release({
            paymentAttemptId: terminal.id,
            releasedAt: terminalAt,
            releaseReason: input.failureCode,
          });
          yield* ReferralInvitationLedger.release({
            paymentAttemptId: terminal.id,
            releasedAt: terminalAt,
            releaseReason: input.failureCode,
          });
          if (
            order.paymentState === "pending" &&
            order.activePaymentAttemptId === terminal.id
          ) {
            yield* db
              .update(orders)
              .set({ paymentState: input.state, updatedAt: terminalAt })
              .where(eq(orders.id, order.id));
            yield* settleEntryPack(order.id);
          }
          return transition(terminal, true);
        }).pipe(Effect.provide(services))
      ),
    fulfill,
    scheduleFulfillment: ({ orderId }) =>
      fulfill(orderId).pipe(
        Effect.catch(() =>
          Effect.logWarning("Entry pack confirmation could not be sent", {
            orderId,
          })
        )
      ),
    startRecovery: ({ paymentAttemptId, verifiedPaidAt, ...input }) =>
      transaction(
        recover({ ...input, id: paymentAttemptId, paidAt: verifiedPaidAt })
      ).pipe(
        Effect.flatMap((recovered) =>
          recovered ? fulfill(input.orderId) : Effect.void
        )
      ),
    resumeRecovery: Effect.fn("entryPack.resumeRecovery")(function* ({
      orderId,
      paymentAttemptId,
    }: Parameters<Handler["resumeRecovery"]>[0]) {
      const [attempt] = yield* readAttempt(orderId, paymentAttemptId);
      if (attempt?.state !== "paid") return false;
      if (attempt.refundState === "not_required") yield* fulfill(orderId);
      return true;
    }),
  } satisfies Handler;
});
