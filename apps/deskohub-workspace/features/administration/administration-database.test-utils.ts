import { DotyposReservationIdSchema } from "@deskohub/dotypos";
import type { WorkspaceReservationRow } from "@/db/schema";
import type { WorkspaceReservationDetails } from "@/features/reservation/backend/workspace-reservation.service";
import { workspaceReservationFixture } from "@/features/reservation/backend/workspace-reservation.test-utils";
import { dotyposCustomerFixture } from "./customer-directory.test-utils";

/**
 * A confirmed `WorkspaceReservationDetails` fixture for administration service
 * tests, with `overrides` applied.
 */
export const workspaceReservationDetailsFixture = (
  overrides: Partial<WorkspaceReservationDetails> = {}
): WorkspaceReservationDetails => {
  const reservation = workspaceReservationFixture();
  const reservedFrom = Temporal.Instant.from("2099-06-01T08:00:00Z");
  const reservedUntil = Temporal.Instant.from("2099-06-01T16:00:00Z");
  return {
    id: reservation.id,
    dotyposCustomerId: reservation.dotyposCustomerId,
    authorAccountId: reservation.authorAccountId,
    reservationDetails: reservation.reservationDetails,
    locale: reservation.locale,
    dotyposReservationId: DotyposReservationIdSchema.make(
      "dotypos-reservation-1"
    ),
    customer: dotyposCustomerFixture(reservation.dotyposCustomerId),
    reservedFrom,
    reservedUntil,
    providerStatus: "CONFIRMED",
    seats: 1,
    placement: {},
    ...overrides,
  };
};

export const reservationSummaryRowValues = (row: WorkspaceReservationRow) =>
  [
    row.id,
    row.activePaymentAttemptId,
    row.dotyposCustomerId,
    row.dotyposReservationId,
    row.reservationState,
    row.paymentState,
    row.fulfillmentState,
    row.reservationDetails,
    row.reservationPurpose,
    row.reservationCreatedAt?.toString() ?? null,
    row.reservationConfirmedAt?.toString() ?? null,
    row.reservationCancelledAt?.toString() ?? null,
    row.cancellationCause,
    row.reservationHoldExpiredAt?.toString() ?? null,
    row.paidAt?.toString() ?? null,
    row.fulfilledAt?.toString() ?? null,
    row.fulfillmentFailedAt?.toString() ?? null,
    row.failureCode,
    row.createdAt.toString(),
    row.updatedAt.toString(),
  ] as const;

export const reservationDetailRowValues = (row: WorkspaceReservationRow) =>
  [
    ...reservationSummaryRowValues(row),
    row.authorAccountId ?? null,
    row.passId,
    row.cancellationEmailSentAt?.toString() ?? null,
    row.checkoutSessionKey,
  ] as const;
