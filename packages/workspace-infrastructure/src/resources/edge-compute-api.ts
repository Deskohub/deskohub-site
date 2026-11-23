import { waitGlobalOperation } from "@alchemy.run/gcp/Compute/operations";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "@alchemy.run/gcp/Labels";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { HttpClientRequest, type HttpClientResponse } from "effect/http";
import * as Schema from "effect/Schema";
import {
  type GoogleApiNoAnswer,
  type GoogleApiRetryPolicy,
  isTransientGoogleApiStatus,
  makeGoogleApi,
} from "../google-api";

/**
 * Compute REST plumbing shared by the edge resources whose fields the
 * native beta.87 providers cannot send: authorized calls, the global
 * operation waiter, and the ownership marker kept in a description.
 */

/**
 * Whether a failed request may or may not have been applied: no answer,
 * rate limiting or a server error.
 */
export const isAmbiguousFailure = (error: { readonly _tag: string }) =>
  error instanceof EdgeComputeRequestFailed &&
  (error.status === null || isTransientGoogleApiStatus(error.status));

/** A Compute request about one edge object failed or was refused. */
export class EdgeComputeRequestFailed extends Data.TaggedError(
  "EdgeComputeRequestFailed"
)<{
  readonly resource: string;
  readonly operation: string;
  readonly status: number | null;
  readonly reason: string;
}> {
  override get message() {
    return `${this.resource}: ${this.operation} failed (${this.status ?? "no answer"}): ${this.reason}`;
  }
}

/**
 * An object of this name exists and carries no ownership marker of this
 * resource, so it belongs to someone else and is never changed.
 */
export class EdgeComputeResourceUnowned extends Data.TaggedError(
  "EdgeComputeResourceUnowned"
)<{ readonly resource: string }> {
  override get message() {
    return `${this.resource} exists and is not owned by this stack`;
  }
}

/** The live object still differs from the declaration after an update. */
export class EdgeComputeResourceNotConverged extends Data.TaggedError(
  "EdgeComputeResourceNotConverged"
)<{ readonly resource: string; readonly fields: ReadonlyArray<string> }> {
  override get message() {
    return `${this.resource} did not converge: ${this.fields.join(", ")}`;
  }
}

export const computeRoot = "https://compute.googleapis.com/compute/v1";

const computeRetry: GoogleApiRetryPolicy = {
  attemptTimeout: "30 seconds",
  backoff: "1 second",
  retries: 4,
};

const noAnswerReasons: Record<GoogleApiNoAnswer, string> = {
  unreachable: "Compute API unreachable",
  "no-answer-in-time": "Compute API did not answer in time",
  "credentials-stalled": "credentials lookup stalled",
};

/**
 * A Compute operation as the waiter reads it. The error envelope is kept:
 * an operation can come back already DONE with an error.
 */
export const ComputeOperation = Schema.Struct({
  name: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  /** The Compute ID of the object the operation changed. */
  targetId: Schema.optional(Schema.String),
  error: Schema.optional(
    Schema.Struct({
      code: Schema.optional(Schema.Finite),
      message: Schema.optional(Schema.String),
      errors: Schema.optional(
        Schema.Array(
          Schema.Struct({
            code: Schema.optional(Schema.String),
            message: Schema.optional(Schema.String),
          })
        )
      ),
    })
  ),
});
export type ComputeOperation = typeof ComputeOperation.Type;

/** Wait for a global operation; it fails with `GCP.OperationFailed`. */
export const settleGlobalOperation = (
  project: string,
  operation: ComputeOperation,
  options?: { readonly ignore?: ReadonlyArray<string> }
) =>
  waitGlobalOperation(
    project,
    // The waiter reads only the operation's name, status and error.
    operation as Parameters<typeof waitGlobalOperation>[1],
    options
  ).pipe(
    Effect.map(
      (settled): ComputeOperation => ({
        name: settled.name,
        status: settled.status,
        targetId: settled.targetId ?? operation.targetId,
      })
    )
  );

/**
 * Fail when a settled operation changed another object than the admitted
 * one: a same-name replacement appeared between the check and the write.
 */
export const requireAdmittedTarget = (
  resource: string,
  admittedId: string | undefined,
  settled: ComputeOperation
) =>
  admittedId !== undefined &&
  settled.targetId !== undefined &&
  settled.targetId !== admittedId
    ? Effect.fail(new EdgeComputeResourceUnowned({ resource }))
    : Effect.void;

/**
 * A Compute mutation request with its own request ID. The ID is fixed
 * before the first attempt, so a retried attempt (after a 5xx or a lost
 * answer) is the same request: Compute returns the original operation
 * instead of applying it again, possibly to a same-name replacement.
 */
const idempotent = (request: HttpClientRequest.HttpClientRequest) =>
  request.pipe(HttpClientRequest.setUrlParam("requestId", crypto.randomUUID()));

/** `projects/…` of a Compute URL, so full and partial links compare equal. */
export const computeResourcePath = (link: string | undefined) => {
  if (link === undefined) {
    return undefined;
  }
  const index = link.indexOf("projects/");
  return index < 0 ? link : link.slice(index);
};

/** The message of a Google error body, never the request. */
const errorReason = (body: string) => {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    return typeof parsed.error?.message === "string"
      ? parsed.error.message
      : "request refused";
  } catch {
    return "request refused";
  }
};

/**
 * Authorized Compute requests about one object. A handler returns
 * `undefined` for an answer it does not accept, which fails with the
 * answer's status and Google's error message.
 */
export const makeEdgeComputeApi = Effect.fnUntraced(function* () {
  const googleApi = yield* makeGoogleApi();

  const send = <A>(
    resource: string,
    operation: string,
    request: HttpClientRequest.HttpClientRequest,
    handle: (
      response: HttpClientResponse.HttpClientResponse
    ) => Effect.Effect<A, EdgeComputeRequestFailed> | undefined,
    policy: GoogleApiRetryPolicy = computeRetry
  ) => {
    const failed = (status: number | null, reason: string) =>
      new EdgeComputeRequestFailed({ resource, operation, status, reason });
    return googleApi.call({
      request: request.pipe(HttpClientRequest.acceptJson),
      policy,
      handle: (response) =>
        handle(response) ??
        response.text.pipe(
          Effect.orElseSucceed(() => ""),
          Effect.flatMap((body) =>
            Effect.fail(failed(response.status, errorReason(body)))
          )
        ),
      transientStatus: (status) =>
        failed(status, `Compute answered HTTP ${status}`),
      noAnswer: (cause) => failed(null, noAnswerReasons[cause]),
      credentialsUnavailable: () => failed(null, "credentials unavailable"),
    });
  };

  /** Decode a JSON answer; an unreadable one fails the request. */
  const decodeJson =
    <A>(
      decodeBody: (body: unknown) => Effect.Effect<A, unknown>,
      resource: string,
      operation: string
    ) =>
    (response: HttpClientResponse.HttpClientResponse) =>
      response.json.pipe(
        Effect.flatMap(decodeBody),
        Effect.mapError(
          () =>
            new EdgeComputeRequestFailed({
              resource,
              operation,
              status: response.status,
              reason: "unreadable Compute answer",
            })
        )
      );

  const decodeOperation = Schema.decodeUnknownEffect(ComputeOperation);

  /** An operation answer on 200, else `undefined`. */
  const operationAnswer =
    (resource: string, operation: string) =>
    (response: HttpClientResponse.HttpClientResponse) =>
      response.status === 200
        ? decodeJson(decodeOperation, resource, operation)(response)
        : undefined;

  /** A GET whose 404 means the object does not exist. */
  const get = <A>(
    resource: string,
    url: string,
    decodeBody: (body: unknown) => Effect.Effect<A, unknown>
  ) =>
    send<A | undefined>(
      resource,
      "get",
      HttpClientRequest.get(url),
      (response) => {
        if (response.status === 404) {
          return Effect.undefined;
        }
        return response.status === 200
          ? decodeJson(decodeBody, resource, "get")(response)
          : undefined;
      }
    );

  /** A mutation answered by an operation. */
  const mutate = (
    resource: string,
    operation: string,
    request: HttpClientRequest.HttpClientRequest
  ) =>
    send(
      resource,
      operation,
      idempotent(request),
      operationAnswer(resource, operation)
    );

  /**
   * A mutation Compute cannot deduplicate (it takes no `requestId`, such
   * as the Cloud Armor rule methods): sent in one attempt only, so a lost
   * answer is never replayed blindly. The caller rereads before any retry.
   */
  const mutateOnce = (
    resource: string,
    operation: string,
    request: HttpClientRequest.HttpClientRequest
  ) =>
    send(resource, operation, request, operationAnswer(resource, operation), {
      ...computeRetry,
      retries: 0,
    });

  return {
    get,
    mutate,
    mutateOnce,
    /** An insert's operation, or `conflict` when the name is taken. */
    insert: (resource: string, url: string, body: object) =>
      send<"conflict" | ComputeOperation>(
        resource,
        "insert",
        idempotent(
          HttpClientRequest.post(url).pipe(
            HttpClientRequest.bodyJsonUnsafe(body)
          )
        ),
        (response) =>
          response.status === 409
            ? Effect.succeed("conflict" as const)
            : operationAnswer(resource, "insert")(response)
      ),
    /** A delete's operation, or `gone` when nothing has the name. */
    delete: (resource: string, url: string) =>
      send<"gone" | ComputeOperation>(
        resource,
        "delete",
        idempotent(HttpClientRequest.delete(url)),
        (response) =>
          response.status === 404
            ? Effect.succeed("gone" as const)
            : operationAnswer(resource, "delete")(response)
      ),
  };
});

const ownershipMarker = (labels: Record<string, string>) =>
  `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;

/**
 * The description an owned object carries: a `[alchemy …]` ownership
 * prefix, the same marker the native Logging exclusion uses, then the
 * declared description.
 */
export const ownedDescription = (id: string, description: string | undefined) =>
  createInternalLabels(id).pipe(
    Effect.map((labels) => {
      const marker = ownershipMarker(labels);
      return description ? `${marker}\n${description}` : marker;
    })
  );

/** The ownership labels and declared description of a live description. */
export const parseOwnedDescription = (description: string | undefined) => {
  if (!description?.startsWith("[alchemy ")) {
    return { labels: {}, description };
  }
  const end = description.indexOf("]");
  if (end < 0) {
    return { labels: {}, description };
  }
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const separator = part.indexOf("=");
    if (separator > 0) {
      labels[part.slice(0, separator)] = part.slice(separator + 1);
    }
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return { labels, description: rest.length > 0 ? rest : undefined };
};

/** Whether a live description marks the object as this resource's. */
export const isOwnedDescription = (
  id: string,
  description: string | undefined
) => hasAlchemyLabels(id, parseOwnedDescription(description).labels);

/** Read again after a mutation; a vanished object fails the reconcile. */
export const requirePresent = <A>(
  resource: string,
  operation: string,
  live: A | undefined
) =>
  live === undefined
    ? Effect.fail(
        new EdgeComputeRequestFailed({
          resource,
          operation,
          status: null,
          reason: "the object is missing after the change",
        })
      )
    : Effect.succeed(live);

/**
 * Whether this resource may change the live object: it is the very object
 * Alchemy admitted (created, or adopted after a read), by its Compute ID,
 * or it carries this resource's ownership marker. A same-name object
 * someone else recreated has a new ID and no marker.
 */
export const isAdmitted = (
  id: string,
  admittedId: string | undefined,
  live: { readonly id?: string; readonly description?: string }
) =>
  admittedId !== undefined && admittedId !== "" && live.id === admittedId
    ? Effect.succeed(true)
    : isOwnedDescription(id, live.description);
