import "@/shared/polyfills/temporal";

import {
  type DotyposReservation,
  type DotyposReservationId,
  DotyposService,
} from "@deskohub/dotypos";
import { Context, Data, Effect, Layer, Predicate } from "effect";
import type { LatePaymentRecovery } from "@/db/schema";
import { AccountingDocumentSnapshotRepository } from "@/features/accounting/backend/accounting-document-snapshot.repository";
import type { PaymentAttemptId } from "@/features/checkout/checkout-identifiers";
import { ReservationOrderSections } from "@/features/reservation/backend/reservation-order-sections";
import { WorkspaceAvailabilityService } from "@/features/reservation/backend/workspace-availability.service";
import {
  type WorkspaceReservation,
  WorkspaceReservationRepository,
} from "@/features/reservation/backend/workspace-reservation.repository";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import {
  hasReservationIntervalEnded,
  type ReservationInterval,
} from "@/features/reservation/reservation-interval";
import { ReservationFulfillment } from "../fulfillment/reservation-fulfillment.service";
import { UnpaidHoldRelease } from "../holds/unpaid-hold-release.service";
import {
  isReusableHold,
  LatePaymentRecoveryRepository,
} from "../repositories/late-payment-recovery.repository";
import { administrationForcedPaymentCancellationFailureCode } from "../repositories/payment-lifecycle.repository";
import {
  findOrderDotyposReservations,
  type RecreatedReservation,
  rebuildAcceptedReservation,
  resumeOrCreateOrderDotyposReservation,
} from "../reservation/order-dotypos-reservation";
import {
  getWorkspaceReservationInterval,
  WorkspaceTableAssignmentService,
} from "../reservation/workspace-table-assignment.service";

export const latePaymentRecoveryMaxExecutionSeconds = 5 * 60;
const recoveryClaimTimeout = Temporal.Duration.from({
  seconds: latePaymentRecoveryMaxExecutionSeconds + 60,
});

type LatePaymentRecoveryOutcome =
  | "ignored"
  | "recovered"
  | "refund_required"
  | "review_required";

class LatePaymentRecoveryError extends Data.TaggedError(
  "LatePaymentRecoveryError"
)<{
  readonly paymentAttemptId: PaymentAttemptId;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ILatePaymentRecoveryService {
  readonly recover: (input: {
    readonly paymentAttemptId: PaymentAttemptId;
  }) => Effect.Effect<LatePaymentRecoveryOutcome, LatePaymentRecoveryError>;
}

/** Why an original hold Dotypos neither holds NEW nor cancelled needs review. */
const unreleasableOriginalHoldFailureCode = (
  status: DotyposReservation["status"]
) =>
  status === "CONFIRMED"
    ? "late_payment_original_confirmed"
    : "late_payment_original_cancellation_uncertain";

/** Why a reservation without a usable snapshot is refunded. */
const unrecreatableReservationFailureCode = (input: {
  readonly newerReservation: boolean;
}) =>
  input.newerReservation
    ? "late_payment_newer_reservation"
    : "late_payment_snapshot_unavailable";

/**
 * Why a claimed late payment can only be refunded before any hold work: its
 * attempt was superseded, or an operator force-cancelled the reservation.
 */
const unrecoverablePaymentFailureCode = (input: {
  readonly claimed: LatePaymentRecovery;
  readonly reservation: WorkspaceReservation;
}) => {
  if (
    input.reservation.activePaymentAttemptId !== input.claimed.paymentAttemptId
  ) {
    return "late_payment_superseded_attempt";
  }
  if (
    input.reservation.failureCode ===
    administrationForcedPaymentCancellationFailureCode
  ) {
    return "late_payment_after_administration_cancellation";
  }
  return null;
};

export class LatePaymentRecoveryService extends Context.Service<
  LatePaymentRecoveryService,
  ILatePaymentRecoveryService
>()("LatePaymentRecoveryService") {
  /** The service over the order sections the caller provides, such as a test's. */
  static withOrderSections = <E, R>(
    orderSections: Layer.Layer<ReservationOrderSections, E, R>
  ) =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const recoveries = yield* LatePaymentRecoveryRepository;
        const reservations = yield* WorkspaceReservationRepository;
        const snapshots = yield* AccountingDocumentSnapshotRepository;
        const availability = yield* WorkspaceAvailabilityService;
        const dotypos = yield* DotyposService;
        const holdRelease = yield* UnpaidHoldRelease;
        const tableAssignments = yield* WorkspaceTableAssignmentService;
        const fulfillment = yield* ReservationFulfillment;
        const orderSections = yield* ReservationOrderSections;

        const settleRefund = (input: {
          readonly paymentAttemptId: PaymentAttemptId;
          readonly workspaceReservationId: WorkspaceReservationId;
          readonly failureCode: string;
        }) =>
          recoveries.requireRefund({
            ...input,
            completedAt: Temporal.Now.instant(),
          });

        const settleReview = (input: {
          readonly paymentAttemptId: PaymentAttemptId;
          readonly workspaceReservationId: WorkspaceReservationId;
          readonly failureCode: string;
        }) =>
          recoveries.requireReview({
            ...input,
            completedAt: Temporal.Now.instant(),
          });

        const retryLater = (
          paymentAttemptId: PaymentAttemptId,
          message: string
        ) => new LatePaymentRecoveryError({ paymentAttemptId, message });

        const refundRecovery = (
          input: {
            readonly paymentAttemptId: PaymentAttemptId;
            readonly reservation: WorkspaceReservation;
          },
          failureCode: string
        ) =>
          settleRefund({
            paymentAttemptId: input.paymentAttemptId,
            workspaceReservationId: input.reservation.id,
            failureCode,
          }).pipe(Effect.as("refund_required" as const));

        const reviewRecovery = (
          input: {
            readonly paymentAttemptId: PaymentAttemptId;
            readonly reservation: WorkspaceReservation;
          },
          failureCode: string
        ) =>
          settleReview({
            paymentAttemptId: input.paymentAttemptId,
            workspaceReservationId: input.reservation.id,
            failureCode,
          }).pipe(Effect.as("review_required" as const));

        /**
         * Cancels the original Dotypos hold and records the local cancellation so
         * the reservation can only continue through normal reservation creation.
         * Fails (to be retried by the queue) while another workflow owns a fresh
         * cancellation or when Dotypos cannot cancel the hold.
         */
        const releaseOriginalHold = Effect.fn(
          "latePaymentRecovery.releaseOriginalHold"
        )(function* (input: {
          readonly paymentAttemptId: PaymentAttemptId;
          readonly reservation: WorkspaceReservation;
          readonly originalDotyposReservationId: DotyposReservationId;
        }) {
          const outcome = yield* holdRelease.release({
            reason: "late_payment",
            reservationId: input.reservation.id,
            originalDotyposReservationId: input.originalDotyposReservationId,
          });
          if (outcome === "in_progress") {
            return yield* retryLater(
              input.paymentAttemptId,
              "Late-payment recovery is waiting for hold cancellation."
            );
          }
          if (outcome === "unclaimed") {
            return yield* retryLater(
              input.paymentAttemptId,
              "Late-payment recovery could not claim the original hold cancellation."
            );
          }
          if (
            outcome === "already_released" ||
            Predicate.hasProperty(outcome, "released")
          ) {
            return "released" as const;
          }
          if (Predicate.hasProperty(outcome, "refused")) {
            return yield* reviewRecovery(
              input,
              unreleasableOriginalHoldFailureCode(outcome.refused)
            );
          }
          return yield* reviewRecovery(
            input,
            "late_payment_reservation_state_unexpected"
          );
        });

        const findRecreatedReservation = Effect.fnUntraced(function* (input: {
          readonly paymentAttemptId: PaymentAttemptId;
          readonly reservation: WorkspaceReservation;
        }) {
          const snapshot = yield* snapshots.findByPaymentAttemptId(
            input.paymentAttemptId
          );
          return snapshot
            ? rebuildAcceptedReservation(input.reservation, snapshot)
            : null;
        });

        // Replacements an earlier run of this recovery created in Dotypos name
        // the payment order in their note.
        const findRecoveryReplacements = (input: {
          readonly reservation: WorkspaceReservation;
          readonly interval: Pick<ReservationInterval, "startsAt" | "endsAt">;
        }) =>
          findOrderDotyposReservations({
            orderId: input.reservation.id,
            interval: input.interval,
          }).pipe(Effect.provideService(DotyposService, dotypos));

        const refundNewerReservation = Effect.fnUntraced(function* (input: {
          readonly paymentAttemptId: PaymentAttemptId;
          readonly reservation: WorkspaceReservation;
          readonly replacements: readonly DotyposReservation[];
        }) {
          const orphanedReplacementId = input.replacements[0]?.id;
          if (orphanedReplacementId) {
            yield* dotypos.cancelReservation(orphanedReplacementId);
          }
          return yield* refundRecovery(input, "late_payment_newer_reservation");
        });

        // A replacement from an interrupted earlier run already passed the
        // availability check and table assignment before it was created; null
        // when a new one can no longer be provided.
        const resumeOrCreateReplacement = Effect.fnUntraced(function* (input: {
          readonly reservation: WorkspaceReservation;
          readonly recreated: RecreatedReservation;
          readonly replacements: readonly DotyposReservation[];
        }) {
          const replacement = yield* resumeOrCreateOrderDotyposReservation({
            order: input.reservation,
            recreated: input.recreated,
            found: input.replacements,
            status: "CONFIRMED",
          }).pipe(
            Effect.provideService(DotyposService, dotypos),
            Effect.provideService(WorkspaceAvailabilityService, availability),
            Effect.provideService(
              WorkspaceTableAssignmentService,
              tableAssignments
            )
          );
          return replacement === null
            ? null
            : {
                replacementId: replacement.id,
                replacementState:
                  replacement.status === "CONFIRMED"
                    ? ("confirmed" as const)
                    : ("held" as const),
              };
        });

        // Settles the recovery with the replacement, cancelling it again when a
        // newer reservation or a gone discount wins at settlement. The caller
        // fulfills a recovered reservation after the order section.
        const settleWithReplacement = Effect.fnUntraced(function* (input: {
          readonly paymentAttemptId: PaymentAttemptId;
          readonly reservation: WorkspaceReservation;
          readonly replacementId: DotyposReservationId | undefined;
          readonly replacementState: "confirmed" | "held";
        }) {
          const { reservation } = input;
          if (!input.replacementId) {
            return yield* reviewRecovery(
              input,
              "late_payment_replacement_id_missing"
            );
          }

          const confirmedReplacementId = input.replacementId;
          yield* recoveries
            .completeWithReplacement({
              paymentAttemptId: input.paymentAttemptId,
              workspaceReservationId: reservation.id,
              recoveredDotyposReservationId: confirmedReplacementId,
              reservationState: input.replacementState,
              completedAt: Temporal.Now.instant(),
            })
            .pipe(
              Effect.catchTag(
                "LatePaymentRecoveryStateError",
                Effect.fn(function* (cause) {
                  const superseded =
                    yield* recoveries.hasNewerActiveReservation(reservation.id);
                  if (!superseded) return yield* cause;
                  yield* dotypos.cancelReservation(confirmedReplacementId);
                  yield* refundRecovery(
                    input,
                    "late_payment_newer_reservation"
                  );
                })
              ),
              Effect.catchTag(
                "DiscountClaimError",
                Effect.fn(function* () {
                  yield* dotypos.cancelReservation(confirmedReplacementId);
                  yield* refundRecovery(
                    input,
                    "late_payment_discount_unavailable"
                  );
                })
              )
            );
          const settled = yield* recoveries.findByPaymentAttemptId(
            input.paymentAttemptId
          );
          if (settled?.state === "refund_required") {
            return "refund_required" as const;
          }
          return "recovered" as const;
        });

        /**
         * Runs the normal reservation creation for the immutable accepted
         * reservation: ended check, current availability, table assignment, and
         * a new confirmed Dotypos reservation. Refunds only when the reservation
         * can no longer be provided.
         */
        const recreateReservation = Effect.fn(
          "latePaymentRecovery.recreateReservation"
        )(function* (input: {
          readonly paymentAttemptId: PaymentAttemptId;
          readonly reservation: WorkspaceReservation;
          readonly newerReservation: boolean;
        }) {
          const recreated = yield* findRecreatedReservation(input);
          if (!recreated) {
            return yield* refundRecovery(
              input,
              unrecreatableReservationFailureCode(input)
            );
          }

          const interval = yield* getWorkspaceReservationInterval(
            recreated.reservation
          );
          if (hasReservationIntervalEnded(interval)) {
            return yield* refundRecovery(
              input,
              "late_payment_reservation_ended"
            );
          }

          const replacements = yield* findRecoveryReplacements({
            reservation: input.reservation,
            interval,
          });
          if (replacements.length > 1) {
            return yield* reviewRecovery(
              input,
              "late_payment_replacement_ambiguous"
            );
          }

          if (input.newerReservation) {
            return yield* refundNewerReservation({ ...input, replacements });
          }

          const replacement = yield* resumeOrCreateReplacement({
            reservation: input.reservation,
            recreated,
            replacements,
          });
          if (!replacement) {
            return yield* refundRecovery(
              input,
              "late_payment_reservation_unavailable"
            );
          }
          return yield* settleWithReplacement({ ...input, ...replacement });
        });

        // A recovery that already ended keeps its outcome; a recovered one runs
        // fulfillment again. Undefined while the recovery is still open.
        const replaySettledRecovery = Effect.fnUntraced(function* (
          current: LatePaymentRecovery | null
        ) {
          if (!current) return "ignored" as const;
          if (current.state === "recovered") {
            yield* fulfillment.run(current.workspaceReservationId);
            return "recovered" as const;
          }
          if (
            current.state === "refund_required" ||
            current.state === "review_required"
          ) {
            return current.state;
          }
          return undefined;
        });

        // Reuses a hold that never passed its deadline. Returns the outcome when
        // reuse settles the recovery, and otherwise whether a newer reservation
        // exists for the recreation that follows. The caller fulfills a
        // recovered reservation after the order section.
        const reuseOriginalHold = Effect.fnUntraced(function* (input: {
          readonly claimed: LatePaymentRecovery;
          readonly reservation: WorkspaceReservation;
          readonly release: () => Effect.Effect<
            "released" | "review_required",
            unknown
          >;
        }) {
          const { claimed, reservation } = input;
          const status = yield* dotypos.getReservationStatus(
            claimed.originalDotyposReservationId
          );
          if (status !== "NEW" && status !== "CONFIRMED") {
            return { newerReservation: false };
          }
          const reuse = yield* recoveries
            .completeUsingOriginalReservation({
              paymentAttemptId: claimed.paymentAttemptId,
              workspaceReservationId: reservation.id,
              reservationState: status === "CONFIRMED" ? "confirmed" : "held",
              completedAt: Temporal.Now.instant(),
            })
            .pipe(
              Effect.as("reused" as const),
              Effect.catchTags({
                DiscountClaimError: () =>
                  Effect.succeed("discount_unavailable" as const),
                // The deadline reached the margin between the first check and
                // the locked settlement: recreate in this same run instead of
                // waiting for the claim timeout.
                OriginalHoldNotReusableError: () =>
                  Effect.succeed("hold_not_reusable" as const),
              })
            );
          if (reuse === "reused") {
            return "recovered" as const;
          }
          if (reuse === "discount_unavailable") {
            // The accepted discounted price can no longer be honoured: free the
            // slot before the refund marks the reservation paid.
            if ((yield* input.release()) === "review_required") {
              return "review_required" as const;
            }
            return yield* refundRecovery(
              { paymentAttemptId: claimed.paymentAttemptId, reservation },
              "late_payment_discount_unavailable"
            );
          }
          return {
            newerReservation: yield* recoveries.hasNewerActiveReservation(
              reservation.id
            ),
          };
        });

        // Reuses the original hold when it may be, and otherwise releases it and
        // recreates the reservation through normal reservation creation.
        const recoverClaimedReservation = Effect.fnUntraced(function* (input: {
          readonly claimed: LatePaymentRecovery;
          readonly reservation: WorkspaceReservation;
        }) {
          const { claimed, reservation } = input;
          let newerReservation = yield* recoveries.hasNewerActiveReservation(
            reservation.id
          );
          // The release reads the current row: a concurrent cleanup may have
          // moved it since this run loaded it.
          const release = () =>
            releaseOriginalHold({
              paymentAttemptId: claimed.paymentAttemptId,
              reservation,
              originalDotyposReservationId:
                claimed.originalDotyposReservationId,
            });

          // Only a hold that never passed its deadline was never offered to
          // other customers as free inventory, so only it skips the normal
          // availability check and table assignment.
          if (
            !newerReservation &&
            isReusableHold(reservation, Temporal.Now.instant())
          ) {
            const reuse = yield* reuseOriginalHold({
              claimed,
              reservation,
              release,
            });
            if (Predicate.isString(reuse)) {
              return reuse;
            }
            newerReservation = reuse.newerReservation;
          }

          if ((yield* release()) === "review_required") {
            return "review_required" as const;
          }
          const released = yield* reservations.findById(reservation.id);
          if (!released) {
            return yield* Effect.die(
              "Late-payment recovery reservation disappeared after release."
            );
          }
          return yield* recreateReservation({
            paymentAttemptId: claimed.paymentAttemptId,
            reservation: released,
            newerReservation,
          });
        });

        // Loads the order under its section, so the unrecoverable check reads
        // the active attempt no payment retry can change before settlement.
        const recoverHeldOrder = Effect.fnUntraced(function* (
          claimed: LatePaymentRecovery
        ) {
          const reservation = yield* reservations.findById(
            claimed.workspaceReservationId
          );
          if (!reservation) {
            return yield* Effect.die(
              "Late-payment recovery reservation missing despite its foreign key."
            );
          }

          const unrecoverableFailureCode = unrecoverablePaymentFailureCode({
            claimed,
            reservation,
          });
          if (unrecoverableFailureCode) {
            return yield* refundRecovery(
              { paymentAttemptId: claimed.paymentAttemptId, reservation },
              unrecoverableFailureCode
            );
          }

          return yield* recoverClaimedReservation({ claimed, reservation });
        });

        const recover = Effect.fn("latePaymentRecovery.recover")(
          function* (input: { readonly paymentAttemptId: PaymentAttemptId }) {
            const current = yield* recoveries.findByPaymentAttemptId(
              input.paymentAttemptId
            );
            const settled = yield* replaySettledRecovery(current);
            if (settled) return settled;

            const claimed = yield* recoveries.claim({
              paymentAttemptId: input.paymentAttemptId,
              staleProcessingBefore:
                Temporal.Now.instant().subtract(recoveryClaimTimeout),
            });
            if (!claimed) {
              return yield* retryLater(
                input.paymentAttemptId,
                "Late-payment recovery is already processing."
              );
            }

            // The order's hold work runs in its section, so no payment retry or
            // submission changes the order's hold or active attempt between
            // recovery's checks and its settlement. Fulfillment runs after the
            // section: settlement already committed the paid order, and
            // fulfillment claims the paid order on its own.
            const outcome = yield* orderSections.withOrder(
              claimed.workspaceReservationId,
              recoverHeldOrder(claimed)
            );
            if (outcome === "recovered") {
              yield* fulfillment.run(claimed.workspaceReservationId);
            }
            return outcome;
          }
        );

        return LatePaymentRecoveryService.of({
          recover: (input) =>
            recover(input).pipe(
              Effect.mapError((cause) =>
                cause instanceof LatePaymentRecoveryError
                  ? cause
                  : new LatePaymentRecoveryError({
                      paymentAttemptId: input.paymentAttemptId,
                      message: "Late-payment recovery failed.",
                      cause,
                    })
              )
            ),
        });
      })
    ).pipe(Layer.provide(orderSections));

  static Default = this.withOrderSections(ReservationOrderSections.Live);
}
