import "server-only";

import { Effect, Match, Option } from "effect";
import { NextResponse } from "next/server";
import { env } from "@/env";
import { cloudTasksInvoker } from "@/shared/backend/google-oidc";
import {
  defineServiceRoute,
  requireGoogleInvoker,
} from "@/shared/backend/service-route";
import {
  type QueueConsumer,
  type QueueDelivery,
  type QueueDeliveryOutcome,
  queueDeliveryModeForStage,
} from "./queue-consumer";

const parseRetryCount = (value: string | null) => {
  const count = value === null ? Number.NaN : Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
};

/**
 * The delivery metadata Cloud Tasks sends with a task. `deliveryCount` is
 * 1-based like Vercel's: `X-CloudTasks-TaskRetryCount` counts every earlier
 * dispatch, including ones answered with a 5xx, while
 * `X-CloudTasks-TaskExecutionCount` leaves those out and so never grows
 * while this adapter answers 500 for a retry.
 */
const cloudTasksDeliveryMetadata = (
  headers: Headers,
  topic: string
): Omit<QueueDelivery, "payload"> => ({
  topic,
  messageId: headers.get("x-cloudtasks-taskname") ?? "unknown",
  deliveryCount:
    parseRetryCount(headers.get("x-cloudtasks-taskretrycount")) + 1,
});

const cloudTasksLogAnnotations = (headers: Headers) => ({
  cloudTasksQueue: headers.get("x-cloudtasks-queuename") ?? undefined,
  cloudTasksEta: headers.get("x-cloudtasks-tasketa") ?? undefined,
});

const readJsonBody = (request: Request) =>
  Effect.tryPromise(() => request.json() as Promise<unknown>).pipe(
    Effect.option
  );

const acknowledged = (status: "handled" | "invalid" | "acknowledged") =>
  NextResponse.json({ status });

/**
 * Cloud Tasks deletes a task on any 2xx and retries any other status with the
 * queue's backoff. It cannot honor a per-response delay, so `RetryAfter` and
 * `RetryAt` retry on that backoff too; deferring work past the queue's
 * retry horizon needs a successor task.
 */
const cloudTasksResponse = (outcome: QueueDeliveryOutcome) =>
  Match.value(outcome).pipe(
    Match.tagsExhaustive({
      Handled: () => acknowledged("handled"),
      Invalid: () => acknowledged("invalid"),
      Failed: ({ action }) =>
        action._tag === "Acknowledge"
          ? acknowledged("acknowledged")
          : NextResponse.json(
              { error: "Queue delivery failed" },
              { status: 500 }
            ),
    })
  );

/**
 * A Cloud Tasks queue handler on the private tasks worker. It accepts only the
 * tasks invoker's Google-signed OIDC token, then runs `consume` with the task
 * body as the payload of `topic`. An unreadable body is acknowledged, as an
 * undecodable payload is.
 */
export const defineCloudTasksQueueRoute = (
  operation: string,
  topic: string,
  consume: QueueConsumer<never>
) =>
  defineServiceRoute(operation, (request) =>
    requireGoogleInvoker(request, cloudTasksInvoker()).pipe(
      Effect.andThen(
        // Task headers are logged only after the request is authenticated.
        readJsonBody(request).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.logWarning(
                  "Cloud Tasks queue message ignored: unreadable body"
                ).pipe(Effect.as(acknowledged("invalid"))),
              onSome: (payload) =>
                consume(
                  {
                    payload,
                    ...cloudTasksDeliveryMetadata(request.headers, topic),
                  },
                  queueDeliveryModeForStage(env.VERCEL_ENV)
                ).pipe(Effect.map(cloudTasksResponse)),
            })
          ),
          Effect.annotateLogs(cloudTasksLogAnnotations(request.headers))
        )
      )
    )
  );
