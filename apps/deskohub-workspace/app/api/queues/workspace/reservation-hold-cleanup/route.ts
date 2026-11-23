import { Effect, Layer } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import {
  processReservationHoldCleanupScheduleMessage,
  ReservationHoldCleanupService,
  reservationHoldCleanupRedelivery,
  reservationHoldCleanupTopic,
} from "@/features/checkout/backend/holds";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import { defineVercelQueueRoute } from "@/shared/backend/queue/vercel-queue-consumer";

const ReservationHoldCleanupScheduleConsumerLive = Layer.mergeAll(
  ReservationHoldCleanupService.Live,
  WorkspaceReservationRepository.Default.pipe(
    Layer.provide(WorkspaceDatabase.Default)
  )
);

export const POST = defineVercelQueueRoute(
  "reservationHoldCleanupSchedule",
  reservationHoldCleanupTopic.consume(
    (message) =>
      processReservationHoldCleanupScheduleMessage(message).pipe(
        Effect.provide(ReservationHoldCleanupScheduleConsumerLive)
      ),
    reservationHoldCleanupRedelivery
  )
);
