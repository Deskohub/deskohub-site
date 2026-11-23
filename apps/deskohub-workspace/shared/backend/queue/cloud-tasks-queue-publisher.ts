import { createHash } from "node:crypto";
import { Data, Duration, Effect, Layer, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { GoogleAccessToken } from "@/shared/backend/google-cloud/google-access-token";
import { currentInstant } from "@/shared/utils/temporal";
import {
  QueueMessageSendError,
  type QueuePublication,
  QueuePublisher,
} from "./queue-publisher";
import {
  isWorkspaceQueueTopic,
  type WorkspaceQueueTopic,
  workspaceQueueTopics,
} from "./workspace-queue-topics";

/** Where and as whom Cloud Tasks delivers Workspace queue messages. */
export type CloudTasksQueueSettings = {
  readonly projectId: string;
  readonly location: string;
  /** Base URL of the private tasks worker that consumes the queues. */
  readonly workerUrl: string;
  /** The service account Cloud Tasks signs each delivery's OIDC token as. */
  readonly invokerServiceAccountEmail: string;
  /** The OIDC audience the tasks worker accepts. */
  readonly audience: string;
};

/** Why Cloud Tasks did not accept a publication. Carries no payload or token. */
export class CloudTasksPublishError extends Data.TaggedError(
  "CloudTasksPublishError"
)<{
  readonly reason:
    | "unknown-topic"
    | "invalid-delay"
    | "delay-beyond-horizon"
    | "transport"
    | "timeout"
    | "status";
  readonly httpStatus?: number | undefined;
  /** The Google API error status, such as `PERMISSION_DENIED`. */
  readonly status?: string | undefined;
}> {}

/** Cloud Tasks rejects a schedule time further ahead than this. */
export const cloudTasksScheduleHorizon = Duration.days(30);

const requestTimeout = Duration.seconds(10);

/** The Cloud Tasks `Task` resource fields a publication sets. */
type HttpTask = {
  readonly name: string;
  /** Omitted from the JSON when undefined: deliver now. */
  readonly scheduleTime: string | undefined;
  readonly httpRequest: {
    readonly url: string;
    readonly httpMethod: "POST";
    readonly headers: { readonly "Content-Type": "application/json" };
    /** The message JSON, base64-encoded. */
    readonly body: string;
    readonly oidcToken: {
      readonly serviceAccountEmail: string;
      readonly audience: string;
    };
  };
};

const GoogleApiErrorBody = Schema.Struct({
  error: Schema.Struct({ status: Schema.String }),
});

/**
 * Publishes Workspace queue messages as Cloud Tasks HTTP tasks. The task name
 * derives from the idempotency key, so Cloud Tasks rejects a repeat as a
 * duplicate.
 */
export const CloudTasksQueuePublisher = (
  settings: CloudTasksQueueSettings
): Layer.Layer<QueuePublisher, never, GoogleAccessToken> =>
  Layer.effect(
    QueuePublisher,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const accessToken = yield* GoogleAccessToken;

      const createTask = Effect.fn("CloudTasksQueuePublisher.createTask")(
        function* (topic: WorkspaceQueueTopic, task: HttpTask) {
          const token = yield* accessToken.get;
          const response = yield* client
            .execute(
              HttpClientRequest.post(
                `https://cloudtasks.googleapis.com/v2/${queuePath(settings, topic)}/tasks`
              ).pipe(
                HttpClientRequest.bearerToken(token),
                HttpClientRequest.bodyJsonUnsafe({ task })
              )
            )
            .pipe(
              Effect.mapError(
                () => new CloudTasksPublishError({ reason: "transport" })
              ),
              Effect.timeoutOrElse({
                duration: requestTimeout,
                orElse: () =>
                  Effect.fail(
                    new CloudTasksPublishError({ reason: "timeout" })
                  ),
              })
            );
          if (response.status >= 200 && response.status < 300) {
            return "published" as const;
          }
          if (response.status === 409) {
            return "duplicate" as const;
          }
          const status = yield* response.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(GoogleApiErrorBody)),
            Effect.map(({ error }) => error.status),
            Effect.orElseSucceed(() => undefined)
          );
          return yield* new CloudTasksPublishError({
            reason: "status",
            httpStatus: response.status,
            status,
          });
        }
      );

      const publishTask = Effect.fn("CloudTasksQueuePublisher.publish")(
        function* ({ topic, message, options }: QueuePublication) {
          if (!isWorkspaceQueueTopic(topic)) {
            return yield* new CloudTasksPublishError({
              reason: "unknown-topic",
            });
          }
          const scheduleTime = yield* scheduleTimeAfter(options.delaySeconds);
          // `retentionSeconds` has no per-task form: a Cloud Tasks queue
          // bounds every task's retries with its own `maxRetryDuration`.
          return yield* createTask(topic, {
            name: `${queuePath(settings, topic)}/tasks/${taskId(options.idempotencyKey)}`,
            scheduleTime,
            httpRequest: {
              url: new URL(workspaceQueueTopics[topic], settings.workerUrl)
                .href,
              httpMethod: "POST",
              headers: { "Content-Type": "application/json" },
              body: Buffer.from(JSON.stringify(message)).toString("base64"),
              oidcToken: {
                serviceAccountEmail: settings.invokerServiceAccountEmail,
                audience: settings.audience,
              },
            },
          });
        }
      );

      return {
        publish: (publication) =>
          publishTask(publication).pipe(
            Effect.mapError(
              (cause) =>
                new QueueMessageSendError({ topic: publication.topic, cause })
            )
          ),
      };
    })
  ).pipe(Layer.provide(FetchHttpClient.layer));

const queuePath = (
  { projectId, location }: CloudTasksQueueSettings,
  topic: WorkspaceQueueTopic
) => `projects/${projectId}/locations/${location}/queues/${topic}`;

/**
 * The task ID for an idempotency key: its SHA-256 in base64url, which fits
 * the Cloud Tasks name grammar and spreads names evenly, as Cloud Tasks
 * recommends.
 */
export const taskId = (idempotencyKey: string) =>
  createHash("sha256").update(idempotencyKey).digest("base64url");

const scheduleTimeAfter = Effect.fn(function* (
  delaySeconds: number | undefined
) {
  if (delaySeconds === undefined || delaySeconds === 0) {
    return undefined;
  }
  if (!Number.isFinite(delaySeconds) || delaySeconds < 0) {
    return yield* new CloudTasksPublishError({ reason: "invalid-delay" });
  }
  if (delaySeconds > Duration.toSeconds(cloudTasksScheduleHorizon)) {
    return yield* new CloudTasksPublishError({
      reason: "delay-beyond-horizon",
    });
  }
  const now = yield* currentInstant;
  return now.add({ milliseconds: Math.round(delaySeconds * 1000) }).toString();
});
