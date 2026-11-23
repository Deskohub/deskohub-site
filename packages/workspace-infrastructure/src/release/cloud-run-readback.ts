import { Credentials } from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import {
  ImageDigest,
  type WorkspaceStackConfig,
  type WorkspaceWorkload,
} from "../config/stack-config";
import type { ObservedService, ObservedTrafficStatus } from "../readback";
import {
  workloadServiceIds,
  workspaceWebServiceId,
} from "../resources/workload-names";
import {
  type ObservedRevision,
  ReleaseReadbackUnavailable,
  ReleaseServiceReadback,
} from "./release-platform";

const cloudRunApiRoot = "https://run.googleapis.com/v2";

/**
 * Retry ceiling for every Cloud Run read. Reads are idempotent, so each
 * attempt gets its own timeout and transient answers (408, 429, 5xx,
 * transport failures, timeouts) retry with exponential backoff.
 */
const cloudRunReadRetry = {
  attemptTimeout: "10 seconds",
  backoff: "250 millis",
  retries: 4,
} as const;

/*
 * Only the fields the readback uses. Proto3 JSON omits default values, so
 * false booleans, zero percentages and empty lists arrive as absent keys.
 */
const CloudRunCondition = Schema.Struct({
  type: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
});

const CloudRunService = Schema.Struct({
  uri: Schema.optional(Schema.String),
  urls: Schema.optional(Schema.Array(Schema.String)),
  ingress: Schema.optional(Schema.String),
  invokerIamDisabled: Schema.optional(Schema.Boolean),
  terminalCondition: Schema.optional(CloudRunCondition),
  reconciling: Schema.optional(Schema.Boolean),
  trafficStatuses: Schema.optional(
    Schema.Array(
      Schema.Struct({
        revision: Schema.optional(Schema.String),
        percent: Schema.optional(Schema.Finite),
        tag: Schema.optional(Schema.String),
      })
    )
  ),
  annotations: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

const CloudRunRevision = Schema.Struct({
  reconciling: Schema.optional(Schema.Boolean),
  conditions: Schema.optional(Schema.Array(CloudRunCondition)),
  containers: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.optional(Schema.String),
        ports: Schema.optional(Schema.Array(Schema.Unknown)),
      })
    )
  ),
  containerStatuses: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.optional(Schema.String),
        imageDigest: Schema.optional(Schema.String),
      })
    )
  ),
});
type CloudRunRevision = typeof CloudRunRevision.Type;

const isImageDigest = Schema.is(ImageDigest);

/**
 * The digest Cloud Run resolved for the serving container: the only
 * container, or the one that receives requests (declares a port). Cloud Run
 * reports either a bare digest or a full `image@sha256:…` reference.
 */
const servingImageDigest = (revision: CloudRunRevision) => {
  const statuses = revision.containerStatuses ?? [];
  const servingName = revision.containers?.find(
    (container) => (container.ports?.length ?? 0) > 0
  )?.name;
  const serving =
    statuses.length === 1
      ? statuses[0]
      : statuses.find(
          (status) => servingName !== undefined && status.name === servingName
        );
  const resolved = serving?.imageDigest;
  if (resolved === undefined) {
    return null;
  }
  const digest = resolved.slice(resolved.lastIndexOf("@") + 1);
  return isImageDigest(digest) ? digest : null;
};

const isReady = (revision: CloudRunRevision) =>
  revision.reconciling !== true &&
  (revision.conditions ?? []).some(
    (condition) =>
      condition.type === "Ready" && condition.state === "CONDITION_SUCCEEDED"
  );

/**
 * The live `ReleaseServiceReadback` over the Cloud Run Admin API v2. Every
 * read goes to the platform with a fresh bearer token; a missing service or
 * revision is null, and anything else unreadable fails
 * `ReleaseReadbackUnavailable` without token or response body content.
 */
export const makeCloudRunServiceReadback = Effect.fnUntraced(function* (
  config: WorkspaceStackConfig
) {
  const credentials = yield* Credentials;
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.timeout(cloudRunReadRetry.attemptTimeout),
    HttpClient.retryTransient({
      schedule: Schedule.exponential(cloudRunReadRetry.backoff),
      times: cloudRunReadRetry.retries,
    })
  );
  const serviceResource = (serviceId: string) =>
    `projects/${config.projectId}/locations/${config.region}/services/${serviceId}`;

  const read = <S extends Schema.Top & { readonly DecodingServices: never }>(
    resource: string,
    schema: S
  ) =>
    Effect.gen(function* () {
      const unavailable = (status: number | null, reason: string) =>
        new ReleaseReadbackUnavailable({ resource, status, reason });
      const { accessToken, quotaProject } = yield* credentials.pipe(
        Effect.mapError(() => unavailable(null, "credentials unavailable"))
      );
      const response = yield* client
        .execute(
          HttpClientRequest.get(`${cloudRunApiRoot}/${resource}`).pipe(
            HttpClientRequest.bearerToken(accessToken),
            HttpClientRequest.acceptJson,
            // User credentials bill quota to an explicit project.
            quotaProject === undefined
              ? (request) => request
              : HttpClientRequest.setHeader("x-goog-user-project", quotaProject)
          )
        )
        .pipe(
          Effect.mapError(() => unavailable(null, "no response from Cloud Run"))
        );
      if (response.status === 404) {
        return null;
      }
      if (response.status !== 200) {
        return yield* unavailable(
          response.status,
          `Cloud Run answered HTTP ${response.status}`
        );
      }
      return yield* response.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(schema)),
        Effect.mapError(() =>
          unavailable(response.status, "unreadable Cloud Run response")
        )
      );
    });

  const readRevision = (serviceId: string, revision: string) =>
    read(
      `${serviceResource(serviceId)}/revisions/${encodeURIComponent(revision)}`,
      CloudRunRevision
    ).pipe(
      Effect.map(
        (live): ObservedRevision | null =>
          live && {
            revision,
            imageDigest: servingImageDigest(live),
            ready: isReady(live),
          }
      )
    );

  const service = Effect.fn("CloudRunServiceReadback.service")(function* (
    workload: WorkspaceWorkload
  ) {
    const serviceId = workloadServiceIds[workload];
    const live = yield* read(serviceResource(serviceId), CloudRunService);
    if (live === null) {
      return null;
    }
    // A LATEST row before its revision resolves names none; it never
    // passes as a revision, so it cannot satisfy a single-revision check.
    const traffic = (live.trafficStatuses ?? []).flatMap(
      ({ revision, percent, tag }): ReadonlyArray<ObservedTrafficStatus> =>
        revision
          ? [{ revision, percent: percent ?? 0, ...(tag ? { tag } : {}) }]
          : []
    );
    const routed = new Set(
      traffic
        .filter((entry) => entry.percent > 0 || entry.tag !== undefined)
        .map((entry) => entry.revision)
    );
    const revisions = yield* Effect.forEach(
      routed,
      (revision) => readRevision(serviceId, revision),
      { concurrency: "unbounded" }
    );
    const revisionDigests: Record<string, ImageDigest> = {};
    for (const revision of revisions) {
      if (revision?.imageDigest) {
        revisionDigests[revision.revision] = revision.imageDigest;
      }
    }
    return {
      workload,
      uri: live.uri,
      urls: live.urls ?? [],
      ingress: live.ingress,
      invokerIamDisabled: live.invokerIamDisabled ?? false,
      terminalConditionState: live.terminalCondition?.state,
      reconciling: live.reconciling ?? false,
      traffic,
      revisionDigests,
      annotations: live.annotations ?? {},
    } satisfies ObservedService;
  });

  return ReleaseServiceReadback.of({
    service,
    revision: Effect.fn("CloudRunServiceReadback.revision")(function* (
      revision: string
    ) {
      return yield* readRevision(workspaceWebServiceId, revision);
    }),
  });
});

/** The live readback for one stack, on its project and region. */
export const cloudRunServiceReadbackLayer = (config: WorkspaceStackConfig) =>
  Layer.effect(ReleaseServiceReadback, makeCloudRunServiceReadback(config));
