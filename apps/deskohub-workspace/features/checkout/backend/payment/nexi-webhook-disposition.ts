import { Array as Arr, Option, pipe, Record } from "effect";
import { WebhookRefusal } from "@/shared/backend/service-route";
import type { NexiWebhookProcessingError } from "./nexi-webhook.service";
import { paymentWebhookDisposition } from "./payment-webhook-disposition";
import type { WebhookFailure } from "./payment-webhook-processor";

const nexiWebhookPrefix = "nexi_webhook_";

type PaymentWebhookDisposition =
  (typeof paymentWebhookDisposition)[WebhookFailure];

/**
 * The answer for a code outside the known failures, which the error code's
 * type already rules out: retried and reported as fatal, as a failed
 * transition is.
 */
const unknownFailureDisposition: PaymentWebhookDisposition =
  paymentWebhookDisposition.transition_failed;

export const nexiWebhookDisposition = (
  code: NexiWebhookProcessingError["errorCode"]
): PaymentWebhookDisposition =>
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
