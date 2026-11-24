import { Array as Arr, Option, pipe, Record } from "effect";
import {
  type WebhookDisposition,
  WebhookRefusal,
} from "@/shared/backend/service-route";
import type { NexiWebhookProcessingError } from "./nexi-webhook.service";
import { paymentWebhookDisposition } from "./payment-webhook-disposition";

const nexiWebhookPrefix = "nexi_webhook_";

/**
 * Retried and reported as fatal: the answer for a code outside the known
 * failures, which the error code's type already rules out.
 */
const unknownFailureDisposition: WebhookDisposition = {
  kind: "retry",
  severity: "fatal",
};

export const nexiWebhookDisposition = (
  code: NexiWebhookProcessingError["errorCode"]
): WebhookDisposition =>
  pipe(
    Record.keys(paymentWebhookDisposition),
    Arr.findFirst((failure) => code === `${nexiWebhookPrefix}${failure}`),
    Option.match({
      onNone: () => unknownFailureDisposition,
      onSome: (failure) => paymentWebhookDisposition[failure],
    })
  );

export const nexiWebhookRefusal = (error: NexiWebhookProcessingError) =>
  new WebhookRefusal({
    disposition: nexiWebhookDisposition(error.errorCode),
    code: error.errorCode,
    details: { eventId: error.eventId, orderId: error.orderId },
    cause: error.cause,
  });
