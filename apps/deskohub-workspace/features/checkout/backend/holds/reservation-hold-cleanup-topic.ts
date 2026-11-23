import { Duration, Schema } from "effect";
import { toStoredInstant } from "@/db/instant";
import {
  type WorkspaceReservationId,
  workspaceReservationIdSchema,
} from "@/features/reservation/persistence-contracts";
import { defineQueueTopic } from "@/shared/backend/queue/queue-topic";
import { clamp } from "@/shared/utils/number";
import { instantStringSchema } from "@/shared/utils/temporal";

export const reservationHoldCleanupScheduleMaxDelaySeconds = 7 * 24 * 60 * 60;
const reservationHoldCleanupRetryWindowSeconds = 60 * 60;

const ReservationHoldCleanupSchedulePayloadSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  orderId: workspaceReservationIdSchema,
  reservationHoldExpiresAtIso: instantStringSchema,
});

export type ReservationHoldCleanupSchedulePayload =
  typeof ReservationHoldCleanupSchedulePayloadSchema.Type;

export type ReservationHoldCleanupSchedule = {
  readonly orderId: WorkspaceReservationId;
  readonly reservationHoldExpiresAt: Temporal.Instant;
};

/**
 * One message per hold deadline, delivered when the hold expires and kept for
 * an hour of retries after it.
 */
export const reservationHoldCleanupTopic = defineQueueTopic({
  topic: "workspace-reservation-hold-cleanup",
  label: "Reservation hold cleanup",
  message: Schema.toStandardSchemaV1(
    ReservationHoldCleanupSchedulePayloadSchema
  ),
  publish: (
    input: ReservationHoldCleanupSchedule & { readonly now: Temporal.Instant }
  ) => {
    const reservationHoldExpiresAtIso = toStoredInstant(
      input.reservationHoldExpiresAt
    ).toString();
    const delaySeconds = clamp(
      Math.ceil(
        (input.reservationHoldExpiresAt.epochMilliseconds -
          input.now.epochMilliseconds) /
          1000
      ),
      0,
      reservationHoldCleanupScheduleMaxDelaySeconds
    );
    const retentionSeconds = clamp(
      delaySeconds + reservationHoldCleanupRetryWindowSeconds,
      60,
      reservationHoldCleanupScheduleMaxDelaySeconds
    );

    return {
      message: {
        schemaVersion: 1 as const,
        orderId: input.orderId,
        reservationHoldExpiresAtIso,
      },
      key: `reservation-hold-cleanup:${input.orderId}:${reservationHoldExpiresAtIso}`,
      delay: Duration.seconds(delaySeconds),
      retention: Duration.seconds(retentionSeconds),
    };
  },
});
