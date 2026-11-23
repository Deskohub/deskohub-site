import { Layer } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import {
  ReservationHoldCleanupService,
  reservationHoldCleanupConsumer,
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
  reservationHoldCleanupConsumer(ReservationHoldCleanupScheduleConsumerLive)
);
