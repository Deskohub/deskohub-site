import { Credentials } from "@alchemy.run/gcp";
import * as Cause from "effect/Cause";
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
import { ReleaseDeployment } from "./release-record";

const cloudRunApiRoot = "https://run.googleapis.com/v2";

/**
 * Retry ceiling for every Cloud Run read. Reads are idempotent, so each
 * attempt, body included, gets its own timeout, and a missing answer, 429
 * or 5xx retries with exponential backoff within one shared budget.
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
 * The status of the serving container. A revision with one container and
 * one status uses that status unless their names disagree; otherwise the
 * serving container is the one named container that declares a port, and
 * only its own status counts.
 */
const servingContainerStatus = (revision: CloudRunRevision) => {
  const containers = revision.containers ?? [];
  const statuses = revision.containerStatuses ?? [];
  const [onlyContainer] = containers;
  const [onlyStatus] = statuses;
  if (containers.length === 1) {
    return statuses.length === 1 &&
      onlyStatus !== undefined &&
      (!onlyContainer?.name ||
        !onlyStatus.name ||
        onlyContainer.name === onlyStatus.name)
      ? onlyStatus
      : undefined;
  }
  const ingress = containers.filter(
    (container) => (container.ports?.length ?? 0) > 0
  );
  const [onlyIngress] = ingress;
  const ingressName = ingress.length === 1 ? onlyIngress?.name : undefined;
  return ingressName
    ? statuses.find((status) => status.name === ingressName)
    : undefined;
};

/**
 * The digest Cloud Run resolved for the serving container, which it reports
 * as a bare digest or a full `image@sha256:…` reference.
 */
const servingImageDigest = (revision: CloudRunRevision) => {
  const resolved = servingContainerStatus(revision)?.imageDigest;
  if (resolved === undefined) {
    return null;
  }
  const digest = resolved.slice(resolved.lastIndexOf("@") + 1);
  return isImageDigest(digest) ? digest : null;
};

/** No answer, rate limiting, or a server error: a later read can succeed. */
const isTransientReadFailure = ({ status }: ReleaseReadbackUnavailable) =>
  status === null || status === 429 || status >= 500;

const isRevisionName = Schema.is(ReleaseDeployment.fields.revision);

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
  // Each attempt owns its request: closing the attempt's scope aborts the
  // transport and any body a status-only answer left unread.
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope);
  const serviceResource = (serviceId: string) =>
    `projects/${config.projectId}/locations/${config.region}/services/${serviceId}`;

  const read = <S extends Schema.Top & { readonly DecodingServices: never }>(
    resource: string,
    schema: S
  ) =>
    Effect.gen(function* () {
      const unavailable = (status: number | null, reason: string) =>
        new ReleaseReadbackUnavailable({ resource, status, reason });
      // Providers may die on a failed token lookup; any outcome but the
      // caller's interruption becomes the same sanitized failure.
      const { accessToken, quotaProject } = yield* credentials.pipe(
        Effect.timeout(cloudRunReadRetry.attemptTimeout),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.fail(unavailable(null, "credentials unavailable"))
        )
      );
      const request = HttpClientRequest.get(
        `${cloudRunApiRoot}/${resource}`
      ).pipe(
        HttpClientRequest.bearerToken(accessToken),
        HttpClientRequest.acceptJson,
        // User credentials bill quota to an explicit project.
        quotaProject
          ? HttpClientRequest.setHeader("x-goog-user-project", quotaProject)
          : (unchanged) => unchanged
      );
      // One attempt runs through the whole body, under one timeout; 404 is
      // the only answer that means absence.
      const attempt = Effect.gen(function* () {
        const response = yield* client
          .execute(request)
          .pipe(
            Effect.mapError(() =>
              unavailable(null, "no response from Cloud Run")
            )
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
        return yield* response.text.pipe(
          Effect.mapError(() => unavailable(null, "Cloud Run body interrupted"))
        );
      }).pipe(
        Effect.scoped,
        Effect.timeoutOrElse({
          duration: cloudRunReadRetry.attemptTimeout,
          orElse: () => Effect.fail(unavailable(null, "Cloud Run timed out")),
        })
      );
      const body = yield* attempt.pipe(
        Effect.retry({
          schedule: Schedule.exponential(cloudRunReadRetry.backoff),
          times: cloudRunReadRetry.retries,
          while: isTransientReadFailure,
        })
      );
      if (body === null) {
        return null;
      }
      return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(
        body
      ).pipe(
        Effect.mapError(() => unavailable(200, "unreadable Cloud Run response"))
      );
    });

  // A name Cloud Run could never assign names no revision; it is never
  // spliced into a request path.
  const readRevision = (serviceId: string, revision: string) =>
    (isRevisionName(revision)
      ? read(
          `${serviceResource(serviceId)}/revisions/${revision}`,
          CloudRunRevision
        )
      : Effect.succeed(null)
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
    // A routed revision deleted between the reads leaves no digest, so its
    // serving image stays unverified instead of failing the whole readback.
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
