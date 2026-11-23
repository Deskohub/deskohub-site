import { Credentials } from "@alchemy.run/gcp";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { HttpClientResponse } from "effect/http";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type {
  GcsBucketName,
  WorkspaceStackConfig,
  WorkspaceStage,
} from "../config/stack-config";
import { emptyReleaseRecord, ReleaseRecord } from "./release-record";
import {
  ReleaseRecordConflict,
  ReleaseRecordCorrupt,
  ReleaseRecordStore,
  ReleaseStoreUnavailable,
  type StoredReleaseRecord,
} from "./release-record-store";

const cloudStorageApi = "https://storage.googleapis.com";

/** Retries after the first attempt for 429, 5xx, transport and timeouts. */
const retriesAfterFirstAttempt = 4;
const retryBackoff = Schedule.exponential("200 millis");
/** Generous: the store is only called from CI and operator runs. */
const attemptTimeout = "30 seconds";

/** Where one stage's release record lives in Cloud Storage. */
export interface GcsReleaseRecordLocation {
  readonly bucket: GcsBucketName;
  readonly object: string;
}

/**
 * The stage's release record object. It sits at the bucket root, outside
 * Alchemy's `{stack}/{stage}/` state prefixes, so state listings never
 * see it.
 */
export const releaseRecordObjectName = (stage: WorkspaceStage) =>
  `workspace-release-record.${stage}.json`;

export const releaseRecordLocation = (
  config: WorkspaceStackConfig
): GcsReleaseRecordLocation => ({
  bucket: config.stateBucket,
  object: releaseRecordObjectName(config.stage),
});

/**
 * An attempt failed in a way a retry may fix. `outcomeUnknown` marks a
 * write that may have landed although no success answer arrived.
 */
class RetryableAttempt extends Data.TaggedError("RetryableAttempt")<{
  readonly status: number | null;
  readonly reason: string;
  readonly outcomeUnknown: boolean;
}> {}

/** The upload's `ifGenerationMatch` precondition no longer held. */
class PreconditionLost extends Data.TaggedError("PreconditionLost") {}

const isRetryable = (error: { readonly _tag: string }) =>
  error._tag === "RetryableAttempt";

const ObjectGeneration = Schema.String.check(Schema.isPattern(/^[0-9]+$/));
const UploadedObjectJson = Schema.fromJsonString(
  Schema.Struct({ generation: ObjectGeneration })
);
const isObjectGeneration = Schema.is(ObjectGeneration);
const StoredRecordJson = Schema.fromJsonString(ReleaseRecord);
const decodeStoredRecord = Schema.decodeUnknownEffect(StoredRecordJson);
const encodeStoredRecord = Schema.encodeEffect(StoredRecordJson);
const decodeUploadedObject = Schema.decodeUnknownEffect(UploadedObjectJson);
const sameRecord = Schema.toEquivalence(ReleaseRecord);

const statusFailure = (
  operation: "read" | "write",
  status: number
): RetryableAttempt | ReleaseStoreUnavailable =>
  status === 429 || status >= 500
    ? new RetryableAttempt({
        status,
        reason: `Cloud Storage answered ${status}`,
        // A rate-limited request was not applied; a server error may have been.
        outcomeUnknown: status >= 500,
      })
    : new ReleaseStoreUnavailable({
        operation,
        status,
        reason:
          status === 401 || status === 403
            ? `Cloud Storage refused the credentials (${status})`
            : `Cloud Storage refused the request (${status})`,
      });

const unavailableAfterRetries =
  (operation: "read" | "write") => (attempt: RetryableAttempt) =>
    new ReleaseStoreUnavailable({
      operation,
      status: attempt.status,
      reason: `${attempt.reason}; gave up after ${retriesAfterFirstAttempt + 1} attempts`,
    });

const retryTransient = <A, E extends { readonly _tag: string }, R>(
  attempt: Effect.Effect<A, E, R>
) =>
  attempt.pipe(
    Effect.retry({
      while: isRetryable,
      times: retriesAfterFirstAttempt,
      schedule: retryBackoff,
    })
  );

/**
 * The release record store on one Cloud Storage object. The object
 * generation is the record version, and every write is a compare-and-set
 * on it (`ifGenerationMatch`), so two runs that read the same version can
 * never both write.
 */
export const makeGcsReleaseRecordStore = Effect.fn(
  "WorkspaceRelease.makeGcsReleaseRecordStore"
)(function* (location: GcsReleaseRecordLocation) {
  const http = yield* HttpClient.HttpClient;
  const credentials = yield* Credentials;
  const bucketPath = encodeURIComponent(location.bucket);
  const objectUrl = `${cloudStorageApi}/storage/v1/b/${bucketPath}/o/${encodeURIComponent(location.object)}`;
  const uploadUrl = `${cloudStorageApi}/upload/storage/v1/b/${bucketPath}/o`;

  /**
   * Attach a bearer token. Nothing is dispatched yet, so a stalled or
   * failed token exchange never makes a write's outcome unknown.
   */
  const authorize = (
    operation: "read" | "write",
    request: HttpClientRequest.HttpClientRequest
  ) =>
    credentials.pipe(
      Effect.mapError(
        () =>
          new ReleaseStoreUnavailable({
            operation,
            status: null,
            reason: "Google Cloud credentials are unavailable",
          })
      ),
      Effect.timeoutOrElse({
        duration: attemptTimeout,
        orElse: () =>
          Effect.fail(
            new RetryableAttempt({
              status: null,
              reason: "Google Cloud credentials did not resolve in time",
              outcomeUnknown: false,
            })
          ),
      }),
      Effect.map(({ accessToken }) =>
        request.pipe(HttpClientRequest.bearerToken(accessToken))
      )
    );

  /**
   * Dispatch an authorized request and handle its response within one
   * bound. From here on a lost answer leaves a write's outcome unknown.
   */
  const exchange = <A, E>(
    request: HttpClientRequest.HttpClientRequest,
    handle: (
      response: HttpClientResponse.HttpClientResponse
    ) => Effect.Effect<A, E>
  ) =>
    http.execute(request).pipe(
      Effect.mapError(
        () =>
          new RetryableAttempt({
            status: null,
            reason: "Cloud Storage could not be reached",
            outcomeUnknown: true,
          })
      ),
      Effect.flatMap(handle),
      Effect.timeoutOrElse({
        duration: attemptTimeout,
        orElse: () =>
          Effect.fail(
            new RetryableAttempt({
              status: null,
              reason: "Cloud Storage did not answer in time",
              outcomeUnknown: true,
            })
          ),
      })
    );

  const bodyText = (response: HttpClientResponse.HttpClientResponse) =>
    response.text.pipe(
      Effect.mapError(
        () =>
          new RetryableAttempt({
            status: response.status,
            reason: "Cloud Storage response body could not be read",
            outcomeUnknown: true,
          })
      )
    );

  const storedObject = (
    response: HttpClientResponse.HttpClientResponse
  ): Effect.Effect<
    { readonly body: string; readonly version: string } | null,
    RetryableAttempt | ReleaseStoreUnavailable
  > => {
    if (response.status === 404) {
      return Effect.succeed(null);
    }
    if (response.status !== 200) {
      return Effect.fail(statusFailure("read", response.status));
    }
    const generation = response.headers["x-goog-generation"];
    return isObjectGeneration(generation)
      ? Effect.map(bodyText(response), (body) => ({
          body,
          version: generation,
        }))
      : Effect.fail(
          new ReleaseStoreUnavailable({
            operation: "read",
            status: response.status,
            reason:
              "Cloud Storage served the record without an object generation",
          })
        );
  };

  const decodeStored = (stored: {
    readonly body: string;
    readonly version: string;
  }) =>
    decodeStoredRecord(stored.body).pipe(
      Effect.map(
        (record): StoredReleaseRecord => ({ record, version: stored.version })
      ),
      // The schema issue may quote stored values; keep the reason fixed.
      Effect.mapError(
        () =>
          new ReleaseRecordCorrupt({
            version: stored.version,
            reason: "the stored object does not decode as a release record",
          })
      )
    );

  /** The stored record, or null while no object exists. */
  const readPresent = authorize(
    "read",
    HttpClientRequest.get(objectUrl).pipe(
      HttpClientRequest.setUrlParam("alt", "media")
    )
  ).pipe(
    Effect.flatMap((request) => exchange(request, storedObject)),
    retryTransient,
    Effect.catchTag("RetryableAttempt", (attempt) =>
      Effect.fail(unavailableAfterRetries("read")(attempt))
    ),
    Effect.flatMap((stored) =>
      stored === null ? Effect.succeed(null) : decodeStored(stored)
    )
  );

  const read: Effect.Effect<
    StoredReleaseRecord,
    ReleaseRecordCorrupt | ReleaseStoreUnavailable
  > = readPresent.pipe(
    Effect.map(
      (stored): StoredReleaseRecord =>
        stored ?? { record: emptyReleaseRecord, version: "0" }
    ),
    Effect.withSpan("WorkspaceRelease.readReleaseRecord")
  );

  const uploadedGeneration = (
    response: HttpClientResponse.HttpClientResponse
  ): Effect.Effect<
    string,
    PreconditionLost | RetryableAttempt | ReleaseStoreUnavailable
  > => {
    if (response.status === 412) {
      return Effect.fail(new PreconditionLost());
    }
    if (response.status !== 200) {
      return Effect.fail(statusFailure("write", response.status));
    }
    // The write landed, but without its generation the version is
    // unknown; the retry's precondition check settles it.
    return bodyText(response).pipe(
      Effect.flatMap(decodeUploadedObject),
      Effect.map((uploaded) => uploaded.generation),
      Effect.mapError(
        () =>
          new RetryableAttempt({
            status: response.status,
            reason: "Cloud Storage did not report the new object generation",
            outcomeUnknown: true,
          })
      )
    );
  };

  /** Upload with retries, noting any attempt whose outcome is unknown. */
  const upload = (input: {
    readonly body: string;
    readonly ifVersion: string;
    readonly outcomeUnknown: Ref.Ref<boolean>;
  }) =>
    authorize(
      "write",
      HttpClientRequest.post(uploadUrl).pipe(
        HttpClientRequest.setUrlParams({
          uploadType: "media",
          name: location.object,
          ifGenerationMatch: input.ifVersion,
        }),
        HttpClientRequest.bodyText(input.body, "application/json")
      )
    ).pipe(
      Effect.flatMap((request) => exchange(request, uploadedGeneration)),
      Effect.tapError((error) =>
        error._tag === "RetryableAttempt" && error.outcomeUnknown
          ? Ref.set(input.outcomeUnknown, true)
          : Effect.void
      ),
      retryTransient,
      Effect.catchTag("RetryableAttempt", (attempt) =>
        Effect.fail(unavailableAfterRetries("write")(attempt))
      )
    );

  /**
   * A retry lost its precondition after an attempt whose outcome is
   * unknown. That attempt landed only if the object now exists at a newer
   * generation holding this call's record; anything else is another
   * writer's.
   */
  const confirmEarlierAttempt = (input: {
    readonly record: ReleaseRecord;
    readonly ifVersion: string;
  }) =>
    readPresent.pipe(
      Effect.filterOrFail(
        (stored): stored is StoredReleaseRecord =>
          stored !== null &&
          stored.version !== input.ifVersion &&
          sameRecord(stored.record, input.record),
        () => new ReleaseRecordConflict({ expectedVersion: input.ifVersion })
      )
    );

  const settleLostPrecondition = (input: {
    readonly record: ReleaseRecord;
    readonly ifVersion: string;
    readonly outcomeUnknown: Ref.Ref<boolean>;
  }) =>
    Ref.get(input.outcomeUnknown).pipe(
      Effect.flatMap((unknown) =>
        unknown
          ? confirmEarlierAttempt(input)
          : Effect.fail(
              new ReleaseRecordConflict({ expectedVersion: input.ifVersion })
            )
      )
    );

  const write = (
    record: ReleaseRecord,
    ifVersion: string
  ): Effect.Effect<
    StoredReleaseRecord,
    ReleaseRecordConflict | ReleaseRecordCorrupt | ReleaseStoreUnavailable
  > =>
    Effect.Do.pipe(
      Effect.let("record", () => record),
      Effect.let("ifVersion", () => ifVersion),
      // The record type guarantees a valid encoding; a failure is a defect.
      Effect.bind("body", () => Effect.orDie(encodeStoredRecord(record))),
      Effect.bind("outcomeUnknown", () => Ref.make(false)),
      Effect.flatMap((input) =>
        upload(input).pipe(
          Effect.map((version): StoredReleaseRecord => ({ record, version })),
          Effect.catchTag("PreconditionLost", () =>
            settleLostPrecondition(input)
          )
        )
      ),
      Effect.withSpan("WorkspaceRelease.writeReleaseRecord")
    );

  return ReleaseRecordStore.of({ read, write });
});

/** The Cloud Storage release record store for one location. */
export const gcsReleaseRecordStoreLayer = (
  location: GcsReleaseRecordLocation
) => Layer.effect(ReleaseRecordStore, makeGcsReleaseRecordStore(location));
