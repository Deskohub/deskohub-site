import {
  consumePaidFulfillmentMessage,
  paidFulfillmentRedelivery,
  paidFulfillmentTopic,
} from "@/features/checkout/backend/fulfillment";
import { defineVercelQueueRoute } from "@/shared/backend/queue/vercel-queue-consumer";

export const maxDuration = 300;

export const POST = defineVercelQueueRoute(
  "paidFulfillmentQueue",
  paidFulfillmentTopic.consume(
    consumePaidFulfillmentMessage,
    paidFulfillmentRedelivery
  )
);
