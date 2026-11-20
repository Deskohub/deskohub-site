import "server-only";

import { DotyposService } from "@deskohub/dotypos";
import { EmailConfigTag, EmailServiceTag } from "@deskohub/email";
import { and, eq, lte, ne } from "drizzle-orm";
import { Context, Effect, Option, Result } from "effect";
import { WorkspaceDatabase, WorkspaceTransaction } from "@/db/database.service";
import { WorkspaceDatabaseAdvisoryLock } from "@/db/postgres-advisory-lock";
import {
  entryPackGiftInvitations,
  orders,
  passPurchases,
  paymentAttempts,
  workspaceReservations,
} from "@/db/schema";
import { WorkspaceLockSections } from "@/db/workspace-locks";
import { findPurchaseLoginEmail } from "@/features/account/backend/customer-account-by-email";
import { CustomerAccountSections } from "@/features/account/backend/customer-account-sections";
import type { PassPurchaseAccountingSnapshot } from "@/features/accounting/accounting-document-snapshot";
import { AccountingDocumentSnapshots } from "@/features/accounting/backend/accounting-document-snapshots";
import { InvoiceRepository } from "@/features/accounting/backend/invoice.repository";
import { InvoiceEmailDeliveryRepository } from "@/features/accounting/backend/invoice-email-delivery.repository";
import { InvoiceEmailDeliveryService } from "@/features/accounting/backend/invoice-email-delivery.service";
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
import type { PaymentLifecycleRepositoryError } from "@/features/checkout/backend/repositories/payment-lifecycle.repository";
import {
  persistDiscountApplications,
  reserveCommittedClaims,
  validateDiscountCommitment,
  validateInternalPaymentCommitment,
} from "@/features/checkout/backend/repositories/payment-lifecycle.repository";
import {
  lifecycleStateError,
  PaymentLifecycleStateError,
} from "@/features/checkout/backend/repositories/payment-lifecycle-state";
import type { PaymentAttemptId } from "@/features/checkout/checkout-identifiers";
import {
  type DiscountCommitment,
  getDiscountCommitmentPayload,
} from "@/features/discounts/commitment";
import { PromotionClaims } from "@/features/discounts/promotion-claims";
import { isEndedUnpaidPaymentState, type OrderId } from "@/features/order";
import { ReferralInvitationLedger } from "@/features/referrals/referral-invitation-ledger";
import { GoogleCalendarWorkspaceLimitationsService } from "@/features/reservation/backend/google-calendar-workspace-limitations.service";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import { SealedStateKeys } from "@/shared/backend/sealed-state-keys.service";
import { moneyEquals } from "@/shared/money/money";
import { currentInstant } from "@/shared/utils/temporal";
import { isEntryPackQuoteExpired } from "../pass-offer";
import { withPassPurchaseAddons } from "../pass-purchase-quote";
import { recordConfirmationInvitationState } from "./entry-pack-gift";
import { deliverPendingEntryPackInvitation } from "./entry-pack-gift-delivery";
import { sendEntryPackPurchaseEmail } from "./entry-pack-purchase-email";
import { settlePassPurchase } from "./entry-pack-settlement";
import {
  confirmUnlimitedPassDays,
  readPayableUnlimitedHolds,
} from "./unlimited-pass-holds";
import { prepareUnlimitedPassRecovery } from "./unlimited-pass-recovery";

export type EntryPackPaymentAdmissionDetails = {
  readonly approvedAfterAttemptId: PaymentAttemptId | null;
  readonly recordConsent: Effect.Effect<void, PaymentLifecycleRepositoryError>;
  readonly commitment: DiscountCommitment;
  readonly snapshot: PassPurchaseAccountingSnapshot;
};

const approvalOperation =
  "PaymentLifecycleRepository.admitEntryPackPaymentApproval";

export const isStaleEntryPackPaymentApproval = (
  error: Error
): error is PaymentLifecycleStateError =>
  error instanceof PaymentLifecycleStateError &&
  error.operation === approvalOperation;

const staleApproval = (orderId: OrderId) =>
  new PaymentLifecycleStateError({
    operation: approvalOperation,
    paymentReference: { type: "orderId", id: orderId },
    message: "The approved Entry pack payment attempt changed.",
  });

type Handler = AdmittingOrderPaymentHandler<EntryPackPaymentAdmissionDetails>;
type ProviderAdmission = Pick<
  Parameters<Handler["admitProvider"]>[0],
  "provider" | "providerOrderId"
>;
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
  yield* settlePassPurchase(order.id);
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
  const advisoryLock = yield* WorkspaceDatabaseAdvisoryLock;
  const dotypos = yield* Effect.serviceOption(DotyposService);
  const calendarLimitations = yield* Effect.serviceOption(
    GoogleCalendarWorkspaceLimitationsService
  );
  const reservations = yield* Effect.serviceOption(
    WorkspaceReservationRepository
  );
  const customerAccounts = yield* CustomerAccountSections;
  const email = yield* EmailServiceTag;
  const emailConfig = yield* EmailConfigTag;
  const snapshots = yield* AccountingDocumentSnapshots;
  const invoices = yield* InvoiceRepository;
  const invoiceDelivery = yield* InvoiceEmailDeliveryService;
  const invoiceDeliveryLedger = yield* InvoiceEmailDeliveryRepository;
  const services = Context.make(WorkspaceDatabase, { db, transaction });
  const sendingServices = services.pipe(
    Context.add(EmailServiceTag, email),
    Context.add(EmailConfigTag, emailConfig),
    Context.add(AccountingDocumentSnapshots, snapshots)
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
    providerAdmission?: ProviderAdmission
  ) {
    const commitment = getDiscountCommitmentPayload(input.details.commitment);
    const claims = yield* providerAdmission === undefined
      ? validateInternalPaymentCommitment(commitment, input.amount)
      : validateDiscountCommitment(commitment);
    const order = yield* lockOrder(
      input.orderId,
      providerAdmission === undefined
        ? { admittedInvitation: claims.referral !== undefined }
        : "nothing"
    );
    const [pack] = yield* db
      .select()
      .from(passPurchases)
      .where(eq(passPurchases.id, order.id));
    const snapshotProduct = input.details.snapshot.product;
    if (
      !pack ||
      pack.locale !== input.locale ||
      commitment.product.kind !== pack.product ||
      commitment.product.tier !== pack.tier ||
      (commitment.product.kind === "entry-pack" &&
        commitment.product.size !== pack.entryCount) ||
      commitment.firstServiceDate !== pack.validFrom ||
      snapshotProduct.kind !== pack.product ||
      snapshotProduct.tier !== pack.tier ||
      (snapshotProduct.kind === "entry-pack" &&
        snapshotProduct.size !== pack.entryCount) ||
      input.details.snapshot.serviceDate !== pack.validFrom ||
      Boolean(input.details.snapshot.unlimitedCoffee) !==
        Boolean(pack.unlimitedCoffee) ||
      !moneyEquals(
        withPassPurchaseAddons(
          pack.quote.discountedSubtotal,
          pack.unlimitedCoffee
        ),
        input.amount
      )
    ) {
      return yield* paymentError(
        order.id,
        "The Entry pack price no longer matches the purchase."
      );
    }
    if (
      order.activePaymentAttemptId !== input.details.approvedAfterAttemptId ||
      (order.activePaymentAttemptId
        ? !isEndedUnpaidPaymentState(order.paymentState)
        : order.paymentState !== "not_started")
    )
      return yield* staleApproval(order.id);

    if (order.activePaymentAttemptId) {
      const [prior] = yield* readAttempt(
        order.id,
        order.activePaymentAttemptId
      );
      if (
        !prior ||
        !isEndedUnpaidPaymentState(prior.state) ||
        prior.refundState !== "not_required"
      )
        return yield* staleApproval(order.id);
    }
    const now = yield* currentInstant;
    if (
      pack.product === "entry-pack" &&
      isEntryPackQuoteExpired(now, pack.validUntil)
    ) {
      return yield* paymentError(
        order.id,
        "The Entry pack quote expired. Request a new quote."
      );
    }
    if (pack.product === "unlimited") {
      yield* readPayableUnlimitedHolds(pack).pipe(
        Effect.catchTag("UnlimitedPassHoldsUnavailable", () =>
          Effect.fail(staleApproval(order.id))
        )
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

    yield* input.details.recordConsent;
    const attempt = yield* insertPaymentAttempt({
      orderId: order.id,
      workspaceReservationId: null,
      amount: input.amount,
      ...(providerAdmission ?? { provider: "internal", paidAt: now }),
    });
    yield* snapshots.recordPassPurchase({
      snapshot: input.details.snapshot,
      paymentAttemptId: attempt.id,
      orderId: order.id,
      dotyposCustomerId: order.dotyposCustomerId,
      amount: input.amount,
      locale: input.locale,
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
    if (!providerAdmission) {
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
    if (pack.product === "unlimited") {
      yield* db
        .update(workspaceReservations)
        .set({ paymentState: "pending", updatedAt: now })
        .where(eq(workspaceReservations.passId, order.id));
    }
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

  const fulfillBuyer = Effect.fn("entryPack.fulfillBuyer")(
    function* (orderId: OrderId) {
      const [paid] = yield* db
        .select({ order: orders, purchase: passPurchases })
        .from(orders)
        .innerJoin(passPurchases, eq(orders.id, passPurchases.id))
        .where(and(eq(orders.id, orderId), eq(orders.paymentState, "paid")));
      if (!paid) return;
      const {
        purchase,
        order: { paidAt, activePaymentAttemptId, fulfillmentState },
      } = paid;
      if (!paidAt || !activePaymentAttemptId)
        return yield* paymentError(
          orderId,
          "Paid Entry pack has no active payment attempt."
        );
      const gift = purchase.buyerAccountId !== purchase.holderAccountId;
      if (
        fulfillmentState !== "not_started" &&
        fulfillmentState !== "awaiting_delivery"
      ) {
        return;
      }
      const attemptIsActive = and(
        eq(orders.id, orderId),
        eq(orders.paymentState, "paid"),
        eq(orders.activePaymentAttemptId, activePaymentAttemptId)
      );
      const confirmation = yield* Effect.gen(function* () {
        if (fulfillmentState !== "not_started") return;
        const snapshot = yield* snapshots.findPassPurchase(
          activePaymentAttemptId
        );
        if (!snapshot) {
          return yield* paymentError(
            orderId,
            "Paid Entry pack has no accounting snapshot."
          );
        }
        const buyer = yield* findPurchaseLoginEmail(
          purchase.buyerAccountId
        ).pipe(Effect.provide(services));
        if (buyer) {
          const holderEmail = gift
            ? ((yield* findPurchaseLoginEmail(purchase.holderAccountId).pipe(
                Effect.provide(services)
              )) ?? null)
            : null;
          const invitationSent = gift
            ? yield* recordConfirmationInvitationState(orderId).pipe(
                Effect.provide(services)
              )
            : false;
          yield* sendEntryPackPurchaseEmail({
            purchase,
            paymentAttemptId: activePaymentAttemptId,
            buyer: { email: buyer },
            holderEmail,
            gift,
            invitationSent,
            paidAt,
            invoiceRequested: snapshot.billing.invoice !== "none",
          }).pipe(Effect.provide(sendingServices));
        }
        // Confirmation settled. Any remaining work belongs to the invoice ledger.
        yield* db
          .update(orders)
          .set({
            fulfillmentState: "awaiting_delivery",
            updatedAt: yield* currentInstant,
          })
          .where(
            and(attemptIsActive, eq(orders.fulfillmentState, "not_started"))
          );
      }).pipe(Effect.result);
      const invoicing = yield* Effect.gen(function* () {
        const invoiceId = yield* invoices.issueEntryPack({
          orderId,
          paymentAttemptId: activePaymentAttemptId,
        });
        if (!invoiceId) return true;
        const delivery = yield* invoiceDelivery.deliverByInvoiceId({
          invoiceId,
        });
        if (delivery.status === "cancelled") return true;
        const ledger = (yield* invoiceDeliveryLedger.status([invoiceId])).get(
          invoiceId
        );
        return (
          ledger?.sentTo.includes("customer") === true &&
          ledger.sentTo.includes("internal")
        );
      }).pipe(Effect.result);
      if (Result.isFailure(confirmation))
        return yield* Effect.fail(confirmation.failure);
      if (Result.isFailure(invoicing))
        return yield* Effect.fail(invoicing.failure);
      if (!invoicing.success) return;
      const now = yield* currentInstant;
      yield* db
        .update(orders)
        .set({
          fulfillmentState: "fulfilled",
          fulfilledAt: now,
          updatedAt: now,
        })
        .where(
          and(attemptIsActive, eq(orders.fulfillmentState, "awaiting_delivery"))
        );
    },
    (effect, orderId) =>
      effect.pipe(
        WorkspaceLockSections.passPurchaseFulfillment(orderId),
        Effect.provideService(WorkspaceDatabaseAdvisoryLock, advisoryLock)
      )
  );

  const fulfillGift = Effect.fn("entryPack.fulfillGift")(function* (
    orderId: OrderId
  ) {
    const [target] = yield* db
      .select({
        generation: entryPackGiftInvitations.generation,
        holderAccountId: passPurchases.holderAccountId,
        paymentAttemptId: orders.activePaymentAttemptId,
      })
      .from(entryPackGiftInvitations)
      .innerJoin(
        passPurchases,
        eq(passPurchases.id, entryPackGiftInvitations.orderId)
      )
      .innerJoin(orders, eq(orders.id, passPurchases.id))
      .where(
        and(
          eq(orders.id, orderId),
          eq(orders.paymentState, "paid"),
          eq(
            entryPackGiftInvitations.holderAccountId,
            passPurchases.holderAccountId
          ),
          ne(passPurchases.buyerAccountId, passPurchases.holderAccountId),
          lte(entryPackGiftInvitations.nextAttemptAt, yield* currentInstant)
        )
      );
    if (!target?.paymentAttemptId) return;

    // Account deletion takes this same section. Acquire it before the order
    // section, and release it before the buyer's independent fulfillment.
    yield* customerAccounts
      .withActiveAccount(
        target.holderAccountId,
        deliverPendingEntryPackInvitation(
          orderId,
          target.paymentAttemptId
        ).pipe(
          Effect.provide(sendingServices),
          Effect.provide(SealedStateKeys.Default),
          Effect.timeout("10 seconds")
        ),
        { recheck: "active", passPurchaseOrderId: orderId }
      )
      .pipe(
        Effect.catchTag("CustomerAccountAccessError", (failure) =>
          failure.reason === "unauthenticated" ||
          failure.linkReason === "deletion-requested"
            ? db
                .update(entryPackGiftInvitations)
                .set({ nextAttemptAt: null })
                .where(
                  and(
                    eq(entryPackGiftInvitations.orderId, orderId),
                    eq(entryPackGiftInvitations.generation, target.generation),
                    eq(
                      entryPackGiftInvitations.holderAccountId,
                      target.holderAccountId
                    )
                  )
                )
                .pipe(Effect.asVoid)
            : Effect.logWarning("Entry pack gift holder could not be rechecked")
        )
      );
  });

  const fulfillUnlimited = Effect.fn("unlimitedPass.fulfillDays")(
    function* (orderId: OrderId) {
      const [purchase] = yield* db
        .select()
        .from(passPurchases)
        .where(eq(passPurchases.id, orderId));
      if (
        purchase?.product !== "unlimited" ||
        purchase.status === "active" ||
        purchase.status === "withdrawn"
      )
        return true;
      if (purchase.status !== "pending_payment") return false;
      const [order] = yield* readOrder(orderId);
      if (order?.paymentState !== "paid") return false;
      if (Option.isNone(dotypos))
        return yield* paymentError(
          orderId,
          "Pass day provider is unavailable."
        );
      const confirmation = yield* confirmUnlimitedPassDays(purchase).pipe(
        Effect.provideService(DotyposService, dotypos.value),
        Effect.result
      );
      if (Result.isFailure(confirmation)) {
        const cause = confirmation.failure;
        if (
          cause._tag !== "DotyposReservationCancelledError" &&
          !(cause._tag === "DotyposRejected" && cause.reason === "not-found") &&
          !(
            cause._tag === "UnlimitedPassHoldsUnavailable" &&
            cause.reason === "changed"
          )
        ) {
          return yield* paymentError(
            orderId,
            "Unlimited pass day confirmation needs reconciliation."
          );
        }
        if (!order.activePaymentAttemptId) {
          return yield* paymentError(
            orderId,
            "Paid Unlimited pass has no active payment attempt."
          );
        }
        const attemptId = order.activePaymentAttemptId;
        const failedAt = yield* currentInstant;
        yield* transaction(
          Effect.gen(function* () {
            const [currentOrder] =
              yield* readOrder(orderId).for("no key update");
            if (
              currentOrder?.activePaymentAttemptId !== attemptId ||
              currentOrder.paymentState !== "paid"
            )
              return;
            yield* db
              .update(passPurchases)
              .set({ status: "void" })
              .where(
                and(
                  eq(passPurchases.id, orderId),
                  eq(passPurchases.status, "pending_payment")
                )
              );
            yield* db
              .update(orders)
              .set({
                fulfillmentState: "failed",
                fulfillmentFailedAt: failedAt,
                fulfillmentFailureCode: "unlimited_pass_day_unavailable",
                updatedAt: failedAt,
              })
              .where(eq(orders.id, orderId));
            yield* db
              .update(paymentAttempts)
              .set({ refundState: "required", updatedAt: failedAt })
              .where(
                and(
                  eq(paymentAttempts.id, attemptId),
                  eq(paymentAttempts.orderId, orderId),
                  ne(paymentAttempts.provider, "internal"),
                  eq(paymentAttempts.refundState, "not_required")
                )
              );
          })
        );
        return false;
      }
      yield* settlePassPurchase(orderId, "completed");
      return true;
    },
    (effect, orderId) =>
      effect.pipe(
        WorkspaceLockSections.passPurchaseFulfillment(orderId),
        Effect.provideService(WorkspaceDatabaseAdvisoryLock, advisoryLock),
        Effect.provide(services)
      )
  );

  const fulfill = Effect.fn("passPurchase.fulfill")(function* (
    orderId: OrderId
  ) {
    if (!(yield* fulfillUnlimited(orderId))) return;
    yield* fulfillGift(orderId).pipe(
      Effect.catch(() =>
        Effect.logWarning("Entry pack gift fulfillment could not complete")
      )
    );
    yield* fulfillBuyer(orderId);
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

  const recover = Effect.fn("passPurchase.recoverPayment")(function* (
    input: Verification,
    unlimitedHoldsReady: boolean | undefined
  ) {
    const order = yield* lockOrder(input.orderId, { claimOf: input.id });
    const [attempt] = yield* readAttempt(order.id, input.id).for("update");
    if (!attempt || attempt.provider === "internal") {
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
      isEndedUnpaidPaymentState(order.paymentState) &&
      unlimitedHoldsReady !== false
    ) {
      const recovered = yield* transaction(
        Effect.gen(function* () {
          if (unlimitedHoldsReady) {
            const [purchase] = yield* db
              .select()
              .from(passPurchases)
              .where(eq(passPurchases.id, order.id));
            if (!purchase) return false;
            const holds = yield* readPayableUnlimitedHolds(purchase).pipe(
              Effect.catchTag(
                "UnlimitedPassHoldsUnavailable",
                () => Effect.undefined
              )
            );
            if (!holds) return false;
          }
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
    if (
      unlimitedHoldsReady !== undefined &&
      order.activePaymentAttemptId === attempt.id &&
      isEndedUnpaidPaymentState(order.paymentState)
    ) {
      yield* db
        .update(passPurchases)
        .set({ status: "void" })
        .where(
          and(
            eq(passPurchases.id, order.id),
            eq(passPurchases.status, "pending_payment")
          )
        );
    }
    return false;
  });

  return {
    load: (orderId) =>
      readOrder(orderId).pipe(
        Effect.map(([order]) =>
          order ? { ...order, logFields: { orderId } } : null
        )
      ),
    admitProvider: ({ provider, providerOrderId, ...input }) =>
      transaction(
        admit(input, { provider, providerOrderId }).pipe(
          Effect.provide(services)
        )
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
            yield* settlePassPurchase(order.id);
          }
          return transition(terminal, true);
        }).pipe(Effect.provide(services))
      ),
    fulfill,
    scheduleFulfillment: ({ orderId }) =>
      fulfill(orderId).pipe(
        Effect.catch(() =>
          Effect.logWarning("Entry pack fulfillment could not complete", {
            orderId,
          })
        )
      ),
    startRecovery: Effect.fn("passPurchase.startRecovery")(function* ({
      paymentAttemptId,
      verifiedPaidAt,
      ...input
    }: Parameters<Handler["startRecovery"]>[0]) {
      const [pass] = yield* db
        .select({ product: passPurchases.product })
        .from(passPurchases)
        .where(eq(passPurchases.id, input.orderId));
      const settle = (ready?: boolean) =>
        transaction(
          recover(
            { ...input, id: paymentAttemptId, paidAt: verifiedPaidAt },
            ready
          )
        );
      const recovered =
        pass?.product === "unlimited"
          ? yield* Effect.gen(function* () {
              const ready =
                Option.isSome(dotypos) &&
                Option.isSome(calendarLimitations) &&
                Option.isSome(reservations) &&
                (yield* prepareUnlimitedPassRecovery(
                  input.orderId,
                  paymentAttemptId
                ).pipe(
                  Effect.provideService(DotyposService, dotypos.value),
                  Effect.provideService(
                    GoogleCalendarWorkspaceLimitationsService,
                    calendarLimitations.value
                  ),
                  Effect.provideService(
                    WorkspaceReservationRepository,
                    reservations.value
                  ),
                  Effect.catch(() => Effect.succeed(false))
                ));
              return yield* settle(ready);
            }).pipe(
              WorkspaceLockSections.unlimitedPassRecovery(input.orderId),
              Effect.provideService(WorkspaceDatabaseAdvisoryLock, advisoryLock)
            )
          : yield* settle();
      if (recovered) yield* fulfill(input.orderId);
    }, Effect.provide(services)),
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
