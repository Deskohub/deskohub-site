import { DuplicateMessageError, send } from "@vercel/queue";
import { Data, Effect, Layer } from "effect";
import {
  QueueMessageSendError,
  QueuePublisher,
  type QueuePublishOutcome,
} from "./queue-publisher";

class DuplicateQueueMessageError extends Data.TaggedError(
  "DuplicateQueueMessageError"
) {}

/** A duplicate idempotency key means the message was already published. */
export const VercelQueuePublisher = Layer.succeed(QueuePublisher, {
  publish: ({ topic, message, options }) =>
    Effect.tryPromise({
      try: () => send(topic, message, options),
      catch: (cause) =>
        cause instanceof DuplicateMessageError
          ? new DuplicateQueueMessageError()
          : new QueueMessageSendError({ topic, cause }),
    }).pipe(
      Effect.as<QueuePublishOutcome>("published"),
      Effect.catchTag("DuplicateQueueMessageError", () =>
        Effect.succeed<QueuePublishOutcome>("duplicate")
      )
    ),
});
