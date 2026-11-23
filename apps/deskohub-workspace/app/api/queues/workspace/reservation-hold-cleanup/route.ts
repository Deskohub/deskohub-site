import { Effect, Layer } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import {
  processReservationHoldCleanupScheduleMessage,
  ReservationHoldCleanupService,
  reservationHoldCleanupRedelivery,
  reservationHoldCleanupTopic,
} from "@/features/checkout/backend/holds";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import { defineQueueRoute } from "@/shared/backend/queue/queue-route";

const ReservationHoldCleanupScheduleConsumerLive = Layer.mergeAll(
  ReservationHoldCleanupService.Live,
  WorkspaceReservationRepository.Default.pipe(
    Layer.provide(WorkspaceDatabase.Default)
  )
);

export const POST = defineQueueRoute(
  "reservationHoldCleanupSchedule",
  reservationHoldCleanupTopic.topic,
  reservationHoldCleanupTopic.consume(
    (message) =>
      processReservationHoldCleanupScheduleMessage(message).pipe(
        Effect.provide(ReservationHoldCleanupScheduleConsumerLive)
      ),
    reservationHoldCleanupRedelivery
  )
);
