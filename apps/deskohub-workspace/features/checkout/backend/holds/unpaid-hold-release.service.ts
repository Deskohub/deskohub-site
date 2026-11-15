import "@/shared/polyfills/temporal";

import {
  type DotyposReservationId,
  type DotyposReservationStatus,
  DotyposService,
  type DotyposWriteFailure,
} from "@deskohub/dotypos";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Context, Effect, Layer, Predicate } from "effect";
import type { WorkspaceReservationDetailsMalformedError } from "@/features/reservation/backend/stored-reservation-details.server";
import type { ReservationCancellationCause } from "@/db/schema";
import {
  hasReservationHold,
  type ReservationHoldIdentity,
  type WorkspaceReservation,
  WorkspaceReservationRepository,
  type WorkspaceReservationStateError,
} from "@/features/reservation/backend/workspace-reservation.repository";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import { DotyposHoldRelease } from "./dotypos-hold-release.service";

/**
 * Why an unpaid hold is released. Each reason brings its own policy:
 *
 * - `hold_expired`: hold cleanup of an expired or abandoned hold.
 * - `late_payment`: late-payment recovery frees the original hold before it
 *   recreates the reservation or refunds.
 * - `agent_rotated`: an agent client's hold left behind in a rotated checkout
 *   session.
 * - `payment_retry`: a payment retry frees the order's hold before it takes a
 *   new one for the same order.
 *
 * Each reason is also the cancellation cause its claim records.
 */
type UnpaidHoldReleaseReason =
  | "hold_expired"
  | "late_payment"
  | "agent_rotated"
  | "payment_retry";

export type UnpaidHoldReleaseRequest =
  | {
      readonly reason: "hold_expired";
      readonly reservationId: WorkspaceReservationId;
      /**
       * The hold cleanup found expired. Cleanup releases only this hold, never
       * a newer one a payment retry gave the reservation since.
       */
      readonly expectedHold: ReservationHoldIdentity;
      /** When cleanup found the hold expired; recorded with the cancellation. */
      readonly holdExpiredAt?: Temporal.Instant;
    }
  | {
      readonly reason: "payment_retry";
      readonly reservationId: WorkspaceReservationId;
      /** The hold the retry read on the order; only this hold is released. */
      readonly expectedHold: ReservationHoldIdentity;
    }
  | {
      readonly reason: "late_payment";
      readonly reservationId: WorkspaceReservationId;
      /**
       * The Dotypos hold the late payment was for, as its recovery recorded
       * it. Released even when another recovery has since written a
       * replacement's hold on the reservation.
       */
      readonly originalDotyposReservationId: DotyposReservationId;
    }
  | {
      readonly reason: "agent_rotated";
      readonly reservationId: WorkspaceReservationId;
    };

/** A hold this run released and marked cancelled. */
interface ReleasedHold {
  /** The reservation as this run took it over, before it was marked cancelled. */
  readonly released: WorkspaceReservation;
  readonly cancelledAt: Temporal.Instant;
}

/** A hold left in Dotypos because of its live status. */
interface RefusedHold {
  readonly refused: DotyposReservationStatus;
}

/**
 * A hold Dotypos had cancelled before any release of ours did, such as an
 * operator's cancellation in Dotypos: marked cancelled with the
 * `provider_cancelled` cause, never reported as this run's release.
 */
interface ProviderCancelledHold {
  /** The reservation as this run took it over, before it was marked cancelled. */
  readonly providerCancelled: WorkspaceReservation;
  readonly cancelledAt: Temporal.Instant;
}

/**
 * - `already_released`: the reservation was cancelled already, or another run
 *   marked it cancelled while this one released it.
 * - `in_progress`: another run's cancellation of it is fresh, so this run
 *   leaves it alone.
 * - `unclaimed`: the reservation changed before this run could claim it, or
 *   it no longer has the hold the request expected.
 * - `unreleasable`: it isn't an unpaid hold with a Dotypos reservation this
 *   reason may release.
 * - `state_changed`: it left `cancelling` before this run marked it
 *   cancelled, after the Dotypos release.
 * - `refused`: the live Dotypos status kept the hold; under `require_new`
 *   the reservation moved to `cancellation_failed`, under
 *   `read_before_claim` it is untouched.
 */
type UnpaidHoldReleaseOutcome =
  | ReleasedHold
  | ProviderCancelledHold
  | "already_released"
  | "in_progress"
  | "unclaimed"
  | "unreleasable"
  | "state_changed"
  | RefusedHold;

type UnpaidHoldReleaseError =
  | DotyposWriteFailure
  | EffectDrizzleQueryError
  | WorkspaceReservationDetailsMalformedError
  | WorkspaceReservationStateError;

/**
 * The `failure_code` a reservation keeps when its Dotypos hold wasn't
 * released. Stored values the administration attention queue reads.
 */
type ReleaseFailureCode =
  | "dotypos_cancel_failed"
  | "checkout_supersession_cancel_failed";

/**
 * How one reason releases a hold after its claim (see `claimHold`).
 *
 * `liveStatus`, what the live Dotypos status must be:
 * - `require_new`: read it after the claim; cancel `NEW`, take `CANCELLED` as
 *   released, refuse anything else.
 * - `read_before_claim`: the late-payment claim read it before claiming and
 *   refused anything but `NEW` and `CANCELLED` without touching the
 *   reservation; cancel only `NEW`.
 *
 * `markerRefused`, what a cancelled marker the reservation's state refuses
 * means:
 * - `state_changed`: the run reports it.
 * - `confirm_cancelled`: another run finished the cancellation when the
 *   reservation reads `cancelled`; the refusal fails the release otherwise.
 * - `fails`: the refusal fails the release.
 *
 * `alreadyCancelled`, what a `CANCELLED` live status after the claim means:
 * - `released`: the hold is released.
 * - `own_release_only`: released only when the cause the claim replaced is
 *   an earlier release of the same kind (`ownReleaseCauses`), such as a
 *   cancel whose outcome was uncertain; otherwise Dotypos cancelled it
 *   without us and the reservation is marked `provider_cancelled`.
 *
 * `markerFence`, whether the cancelled and failure markers also require the
 * reservation to still name the released hold (`claimed_hold`), so a delayed
 * run can't finish a newer hold's cancellation. Late payment releases the
 * original hold its recovery recorded, which the reservation may no longer
 * name (`none`).
 */
interface ReleasePolicy {
  readonly liveStatus: "require_new" | "read_before_claim";
  readonly failureCode: ReleaseFailureCode;
  readonly markerRefused: "state_changed" | "confirm_cancelled" | "fails";
  readonly alreadyCancelled: "released" | "own_release_only";
  readonly markerFence: "claimed_hold" | "none";
}

const releasePolicies = {
  hold_expired: {
    liveStatus: "require_new",
    failureCode: "dotypos_cancel_failed",
    markerRefused: "state_changed",
    alreadyCancelled: "own_release_only",
    markerFence: "claimed_hold",
  },
  payment_retry: {
    liveStatus: "require_new",
    failureCode: "dotypos_cancel_failed",
    markerRefused: "confirm_cancelled",
    alreadyCancelled: "own_release_only",
    markerFence: "claimed_hold",
  },
  late_payment: {
    liveStatus: "read_before_claim",
    failureCode: "dotypos_cancel_failed",
    markerRefused: "confirm_cancelled",
    alreadyCancelled: "released",
    markerFence: "none",
  },
  agent_rotated: {
    liveStatus: "require_new",
    failureCode: "checkout_supersession_cancel_failed",
    markerRefused: "fails",
    alreadyCancelled: "released",
    markerFence: "claimed_hold",
  },
} as const satisfies Record<UnpaidHoldReleaseReason, ReleasePolicy>;

/**
 * Causes of the releases of an order's own expired or retried hold. A
 * `CANCELLED` hold after an earlier claim under one of them is that claim's
 * release finishing.
 */
const ownReleaseCauses: ReadonlySet<ReservationCancellationCause | null> =
  new Set<ReservationCancellationCause | null>([
    "hold_expired",
    "payment_retry",
  ]);

/**
 * Local states whose Dotypos hold may still exist, as late-payment recovery
 * finds them before it releases the hold.
 */
const releasableReservationStates: ReadonlySet<string> = new Set([
  "held",
  "hold_expired",
  "cancellation_failed",
  "cancelling",
]);

/**
 * A `cancelling` reservation untouched for this long belongs to an
 * interrupted run, so a late-payment release may finish it instead of
 * waiting indefinitely.
 */
const staleHoldCancellationAfter = Temporal.Duration.from({ minutes: 10 });

/** A fresh `cancelling` reservation belongs to a run that is still going. */
const isHoldCancellationFresh = (reservation: WorkspaceReservation) =>
  Temporal.Instant.compare(
    reservation.updatedAt,
    Temporal.Now.instant().subtract(staleHoldCancellationAfter)
  ) > 0;

/**
 * A claimed hold, with the live status read before the claim, if any, and the
 * cancellation cause the reservation carried before this run's claim.
 */
interface ClaimedHold {
  readonly reservation: WorkspaceReservation;
  readonly dotyposReservationId: DotyposReservationId;
  readonly previousCancellationCause: ReservationCancellationCause | null;
  readonly statusBeforeClaim?: "NEW" | "CANCELLED";
}

/** A hold this run claimed, or the outcome that ended the release first. */
type ClaimResult =
  | ClaimedHold
  | Exclude<
      UnpaidHoldReleaseOutcome,
      ReleasedHold | ProviderCancelledHold | "state_changed"
    >;

const isClaimedHold = (result: ClaimResult): result is ClaimedHold =>
  !Predicate.isString(result) && "reservation" in result;

interface IUnpaidHoldRelease {
  /**
   * Releases an unpaid reservation hold for a reason: claims the
   * reservation's cancellation, releases its Dotypos hold under the reason's
   * live-status rule, and marks the reservation cancelled. A hold left in
   * Dotypos after the claim moves the reservation to `cancellation_failed`
   * with the reason's stored code, and a Dotypos failure fails the release
   * after that marker.
   */
  readonly release: (
    request: UnpaidHoldReleaseRequest
  ) => Effect.Effect<UnpaidHoldReleaseOutcome, UnpaidHoldReleaseError>;
}

export class UnpaidHoldRelease extends Context.Service<
  UnpaidHoldRelease,
  IUnpaidHoldRelease
>()("UnpaidHoldRelease") {
  static Default = Layer.effect(
    this,
    Effect.gen(function* () {
      const reservations = yield* WorkspaceReservationRepository;
      const dotypos = yield* DotyposService;
      const holdRelease = yield* DotyposHoldRelease;

      // Claims the cancellation of the expected hold, or takes over a
      // `cancelling` reservation another run claimed while it still has that
      // hold; unclaimed when it has another hold, unreleasable after logging
      // why it may not be released.
      const claimResumingClaimed = Effect.fnUntraced(function* (request: {
        readonly reservationId: WorkspaceReservationId;
        readonly expectedHold: ReservationHoldIdentity;
      }): Effect.fn.Return<ClaimResult, UnpaidHoldReleaseError> {
        const claimedFromNew = yield* reservations.claimCancellation(
          request.reservationId,
          "hold_expired",
          request.expectedHold
        );
        yield* Effect.logDebug(
          "Reservation hold cancellation claim completed",
          { claimedFromNew: claimedFromNew !== null }
        );
        const claimed =
          claimedFromNew?.reservation ??
          (yield* reservations.findById(request.reservationId));
        if (claimed && !hasReservationHold(claimed, request.expectedHold)) {
          yield* Effect.logWarning(
            "Reservation hold cancellation skipped: reservation has another hold"
          );
          return "unclaimed" as const;
        }
        if (claimed?.reservationState !== "cancelling") {
          yield* Effect.logWarning(
            "Reservation hold cancellation skipped: claim not cancellable"
          );
          return "unreleasable" as const;
        }
        if (!claimed.dotyposReservationId) {
          yield* Effect.logWarning(
            "Reservation hold cancellation skipped: missing Dotypos reservation"
          );
          return "unreleasable" as const;
        }
        if (claimed.paymentState === "paid") {
          yield* Effect.logWarning(
            "Reservation hold cancellation skipped: reservation paid"
          );
          return "unreleasable" as const;
        }
        return {
          reservation: claimed,
          dotyposReservationId: claimed.dotyposReservationId,
          previousCancellationCause: claimedFromNew
            ? claimedFromNew.previousCancellationCause
            : claimed.cancellationCause,
        } satisfies ClaimedHold;
      });

      // From the current reservation, releases a cancelled one as done
      // without asking Dotypos, waits out a fresh `cancelling` one, and
      // otherwise claims the expected hold's cancellation or takes over a
      // stale `cancelling` reservation that still has it.
      const claimForPaymentRetry = Effect.fnUntraced(function* (request: {
        readonly reservationId: WorkspaceReservationId;
        readonly expectedHold: ReservationHoldIdentity;
      }): Effect.fn.Return<ClaimResult, UnpaidHoldReleaseError> {
        const reservation = yield* reservations.findById(request.reservationId);
        if (!reservation) {
          return yield* Effect.die(
            "Unpaid hold release reservation disappeared before release."
          );
        }
        if (reservation.reservationState === "cancelled") {
          return "already_released" as const;
        }
        if (reservation.reservationState === "cancelling") {
          if (isHoldCancellationFresh(reservation)) return "in_progress" as const;
          if (!hasReservationHold(reservation, request.expectedHold)) {
            return "unclaimed" as const;
          }
          if (reservation.paymentState === "paid") {
            return "unreleasable" as const;
          }
          return {
            reservation,
            dotyposReservationId: request.expectedHold.dotyposReservationId,
            previousCancellationCause: reservation.cancellationCause,
          } satisfies ClaimedHold;
        }
        if (!releasableReservationStates.has(reservation.reservationState)) {
          return "unreleasable" as const;
        }
        const claimed = yield* reservations.claimCancellation(
          reservation.id,
          "payment_retry",
          request.expectedHold
        );
        if (!claimed) return "unclaimed" as const;
        return {
          reservation: claimed.reservation,
          dotyposReservationId: request.expectedHold.dotyposReservationId,
          previousCancellationCause: claimed.previousCancellationCause,
        } satisfies ClaimedHold;
      });

      // Claims a `held` reservation whose payment may be superseded.
      const claimSupersession = Effect.fnUntraced(function* (
        reservationId: WorkspaceReservationId
      ): Effect.fn.Return<ClaimResult, UnpaidHoldReleaseError> {
        const claimed = yield* reservations.claimSupersessionCancellation(
          reservationId,
          "agent_rotated"
        );
        if (!claimed) return "unclaimed" as const;
        // workspace_reservations_hold_id_check rejects a cancelling row
        // without its Dotypos hold, so a claimed row always carries one.
        if (!claimed.dotyposReservationId) return "unreleasable" as const;
        return {
          reservation: claimed,
          dotyposReservationId: claimed.dotyposReservationId,
          // Only `held` reservations are claimed, so no earlier claim's cause.
          previousCancellationCause: null,
        } satisfies ClaimedHold;
      });

      // From the current reservation, releases a cancelled one as done, waits
      // out a fresh `cancelling` one, takes over a stale one, and claims the
      // cancellation otherwise. Reads the original hold's live status before
      // the claim, so a hold Dotypos no longer keeps pending leaves the
      // reservation untouched.
      const claimResumingStale = Effect.fnUntraced(function* (request: {
        readonly reservationId: WorkspaceReservationId;
        readonly originalDotyposReservationId: DotyposReservationId;
      }): Effect.fn.Return<ClaimResult, UnpaidHoldReleaseError> {
        const reservation = yield* reservations.findById(request.reservationId);
        if (!reservation) {
          return yield* Effect.die(
            "Unpaid hold release reservation disappeared before release."
          );
        }
        if (reservation.reservationState === "cancelled") {
          return "already_released" as const;
        }
        if (!releasableReservationStates.has(reservation.reservationState)) {
          return "unreleasable" as const;
        }
        const resumesStaleCancellation =
          reservation.reservationState === "cancelling";
        if (resumesStaleCancellation && isHoldCancellationFresh(reservation)) {
          return "in_progress" as const;
        }

        const status = yield* dotypos.getReservationStatus(
          request.originalDotyposReservationId
        );
        if (status !== "NEW" && status !== "CANCELLED") {
          return { refused: status } satisfies RefusedHold;
        }
        if (
          !resumesStaleCancellation &&
          !(yield* reservations.claimCancellation(
            reservation.id,
            "late_payment"
          ))
        ) {
          return "unclaimed" as const;
        }
        return {
          reservation,
          dotyposReservationId: request.originalDotyposReservationId,
          previousCancellationCause: reservation.cancellationCause,
          statusBeforeClaim: status,
        } satisfies ClaimedHold;
      });

      // Each reason's claim. Hold cleanup, payment retry, and agent rotated
      // holds release the Dotypos hold on the row they claimed; late payment
      // releases the original hold its recovery recorded.
      const claimHold = (request: UnpaidHoldReleaseRequest) => {
        switch (request.reason) {
          case "hold_expired":
            return claimResumingClaimed(request);
          case "payment_retry":
            return claimForPaymentRetry(request);
          case "late_payment":
            return claimResumingStale(request);
          case "agent_rotated":
            return claimSupersession(request.reservationId);
        }
      };

      // Releases the claimed hold in Dotypos: a refusal when its live status
      // keeps it there, whether Dotypos had cancelled it already otherwise.
      const releaseDotyposHold = (
        policy: ReleasePolicy,
        claimed: ClaimedHold
      ) => {
        if (claimed.statusBeforeClaim === "CANCELLED") {
          return Effect.succeed("already_cancelled" as const);
        }
        return holdRelease.release({
          reservationId: claimed.reservation.id,
          dotyposReservationId: claimed.dotyposReservationId,
          liveStatus:
            policy.liveStatus === "require_new" ? "require_new" : "unchecked",
          failureCode: policy.failureCode,
          failureMarkerFence:
            policy.markerFence === "claimed_hold"
              ? "dotypos_reservation"
              : "none",
        });
      };

      // Marks the released hold cancelled; a marker the reservation's state
      // refuses is settled under the policy.
      const markReleased = Effect.fnUntraced(function* (
        policy: ReleasePolicy,
        claimed: ClaimedHold,
        marker: {
          readonly holdExpiredAt?: Temporal.Instant;
          readonly providerCancelled: boolean;
        }
      ) {
        const cancelledAt = Temporal.Now.instant();
        return yield* reservations
          .markCancelled({
            id: claimed.reservation.id,
            cancelledAt,
            ...(marker.holdExpiredAt && {
              holdExpiredAt: marker.holdExpiredAt,
            }),
            ...(marker.providerCancelled && {
              cancellationCause: "provider_cancelled" as const,
            }),
            ...(policy.markerFence === "claimed_hold" && {
              dotyposReservationId: claimed.dotyposReservationId,
            }),
          })
          .pipe(
            Effect.as<UnpaidHoldReleaseOutcome>(
              marker.providerCancelled
                ? { providerCancelled: claimed.reservation, cancelledAt }
                : { released: claimed.reservation, cancelledAt }
            ),
            Effect.catchTag(
              "WorkspaceReservationStateError",
              Effect.fnUntraced(function* (refusal) {
                if (policy.markerRefused === "state_changed") {
                  return "state_changed" as const;
                }
                if (policy.markerRefused === "confirm_cancelled") {
                  const current = yield* reservations.findById(
                    claimed.reservation.id
                  );
                  if (current?.reservationState === "cancelled") {
                    return "already_released" as const;
                  }
                }
                return yield* refusal;
              })
            )
          );
      });

      return UnpaidHoldRelease.of({
        release: Effect.fn("unpaidHoldRelease.release")(function* (request) {
          yield* Effect.annotateCurrentSpan({ reason: request.reason });
          const policy: ReleasePolicy = releasePolicies[request.reason];
          const claimed = yield* claimHold(request);
          if (!isClaimedHold(claimed)) return claimed;
          const released = yield* releaseDotyposHold(policy, claimed);
          if (!Predicate.isString(released)) return released;
          return yield* markReleased(policy, claimed, {
            // Only cleanup records when it found the hold expired; the other
            // reasons leave the column untouched.
            ...(request.reason === "hold_expired" && {
              holdExpiredAt: request.holdExpiredAt,
            }),
            providerCancelled:
              released === "already_cancelled" &&
              policy.alreadyCancelled === "own_release_only" &&
              !ownReleaseCauses.has(claimed.previousCancellationCause),
          });
        }),
      });
    })
  ).pipe(Layer.provide(DotyposHoldRelease.Default));
}
