import { waitGlobalOperation } from "@alchemy.run/gcp/Compute/operations";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "@alchemy.run/gcp/Labels";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { HttpClientRequest, type HttpClientResponse } from "effect/http";
import * as Schema from "effect/Schema";
import {
  type GoogleApiNoAnswer,
  type GoogleApiRetryPolicy,
  makeGoogleApi,
} from "../google-api";

/**
 * Cloud CDN settings of a backend that caches. Only the fields the
 * Workspace edge sets; Google fills the rest with its defaults.
 */
export interface EdgeCdnPolicy {
  readonly cacheMode: "USE_ORIGIN_HEADERS";
  readonly negativeCaching: boolean;
  readonly cacheKeyPolicy: {
    readonly includeHost: boolean;
    readonly includeProtocol: boolean;
    readonly includeQueryString: boolean;
  };
}

export interface EdgeLogConfig {
  readonly enable: boolean;
  /** Fraction of requests logged; only meaningful while `enable` is true. */
  readonly sampleRate?: number;
}

export interface EdgeBackendServiceProps {
  /** Project of the backend; identity, so a change replaces it. */
  readonly project: string;
  /** Backend service name; identity, so a change replaces it. */
  readonly name: string;
  readonly description?: string;
  /** Immutable in Compute, so a change replaces the backend. */
  readonly loadBalancingScheme: "EXTERNAL_MANAGED";
  readonly protocol: "HTTPS";
  /** Self link of the one serverless network endpoint group behind it. */
  readonly backendGroup: string;
  /** Self link of the Cloud Armor policy attached to it. */
  readonly securityPolicy: string;
  readonly logConfig: EdgeLogConfig;
  /** Cloud CDN is on exactly when a policy is given. */
  readonly cdnPolicy?: EdgeCdnPolicy;
}

export interface EdgeBackendServiceAttributes {
  readonly project: string;
  readonly name: string;
  readonly id: string;
  readonly selfLink: string;
  readonly creationTimestamp: string;
  readonly loadBalancingScheme: string;
  readonly protocol: string;
  readonly backendGroups: ReadonlyArray<string>;
  readonly securityPolicy: string | undefined;
  readonly enableCDN: boolean;
  readonly cdnPolicy: EdgeCdnPolicy | undefined;
  readonly logConfig: EdgeLogConfig;
  /** The description with the Alchemy ownership marker stripped. */
  readonly description: string | undefined;
}

/**
 * A global backend service of the Workspace edge. The native beta.87
 * `GCP.Compute.BackendService` neither sends `cdnPolicy` nor attaches a
 * Cloud Armor policy, so this resource alone owns the whole object: its
 * fields, its CDN policy and its security policy attachment.
 */
export type EdgeBackendService = Resource<
  "DeskohubWorkspace.EdgeBackendService",
  EdgeBackendServiceProps,
  EdgeBackendServiceAttributes
>;
export const EdgeBackendService = Resource<EdgeBackendService>(
  "DeskohubWorkspace.EdgeBackendService"
);

/** A Compute request about one backend failed or was refused. */
export class EdgeBackendServiceRequestFailed extends Data.TaggedError(
  "EdgeBackendServiceRequestFailed"
)<{
  readonly backendService: string;
  readonly operation: string;
  readonly status: number | null;
  readonly reason: string;
}> {
  override get message() {
    return `Backend service ${this.backendService}: ${this.operation} failed (${this.status ?? "no answer"}): ${this.reason}`;
  }
}

/**
 * A backend of this name exists and carries no ownership marker of this
 * resource, so it belongs to someone else and is never changed.
 */
export class EdgeBackendServiceUnowned extends Data.TaggedError(
  "EdgeBackendServiceUnowned"
)<{ readonly backendService: string }> {
  override get message() {
    return `Backend service ${this.backendService} exists and is not owned by this stack`;
  }
}

/** The live backend still differs from the declaration after an update. */
export class EdgeBackendServiceNotConverged extends Data.TaggedError(
  "EdgeBackendServiceNotConverged"
)<{ readonly backendService: string; readonly fields: ReadonlyArray<string> }> {
  override get message() {
    return `Backend service ${this.backendService} did not converge: ${this.fields.join(", ")}`;
  }
}

const computeRoot = "https://compute.googleapis.com/compute/v1";

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

const LiveBackendService = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  selfLink: Schema.optional(Schema.String),
  creationTimestamp: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  fingerprint: Schema.optional(Schema.String),
  loadBalancingScheme: Schema.optional(Schema.String),
  protocol: Schema.optional(Schema.String),
  backends: Schema.optional(
    Schema.Array(Schema.Struct({ group: Schema.optional(Schema.String) }))
  ),
  securityPolicy: Schema.optional(Schema.String),
  enableCDN: Schema.optional(Schema.Boolean),
  cdnPolicy: Schema.optional(
    Schema.Struct({
      cacheMode: Schema.optional(Schema.String),
      negativeCaching: Schema.optional(Schema.Boolean),
      cacheKeyPolicy: Schema.optional(
        Schema.Struct({
          includeHost: Schema.optional(Schema.Boolean),
          includeProtocol: Schema.optional(Schema.Boolean),
          includeQueryString: Schema.optional(Schema.Boolean),
        })
      ),
    })
  ),
  logConfig: Schema.optional(
    Schema.Struct({
      enable: Schema.optional(Schema.Boolean),
      sampleRate: Schema.optional(Schema.Finite),
    })
  ),
});
type LiveBackendService = typeof LiveBackendService.Type;

const ComputeOperation = Schema.Struct({
  name: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
});
type LiveOperation = typeof ComputeOperation.Type;

/** `projects/…` of a Compute URL, so full and partial links compare equal. */
const resourcePath = (link: string | undefined) => {
  if (link === undefined) {
    return undefined;
  }
  const index = link.indexOf("projects/");
  return index < 0 ? link : link.slice(index);
};

const ownershipMarker = (labels: Record<string, string>) =>
  `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;

/**
 * Backend services have no labels, so ownership is a `[alchemy …]` prefix
 * of the description, the same marker the native Logging exclusion uses.
 */
const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined
) => {
  const marker = ownershipMarker(labels);
  return description ? `${marker}\n${description}` : marker;
};

const parseDescription = (description: string | undefined) => {
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

const isOwned = (id: string, live: LiveBackendService) =>
  hasAlchemyLabels(id, parseDescription(live.description).labels);

const toAttributes = (
  project: string,
  live: LiveBackendService
): EdgeBackendServiceAttributes => {
  const cdn = live.cdnPolicy;
  return {
    project,
    name: live.name ?? "",
    id: live.id ?? "",
    selfLink: live.selfLink ?? "",
    creationTimestamp: live.creationTimestamp ?? "",
    loadBalancingScheme: live.loadBalancingScheme ?? "",
    protocol: live.protocol ?? "",
    backendGroups: (live.backends ?? []).flatMap((backend) =>
      backend.group === undefined ? [] : [backend.group]
    ),
    securityPolicy: live.securityPolicy,
    enableCDN: live.enableCDN === true,
    cdnPolicy:
      live.enableCDN === true && cdn !== undefined
        ? {
            cacheMode: cdn.cacheMode as EdgeCdnPolicy["cacheMode"],
            negativeCaching: cdn.negativeCaching === true,
            cacheKeyPolicy: {
              includeHost: cdn.cacheKeyPolicy?.includeHost === true,
              includeProtocol: cdn.cacheKeyPolicy?.includeProtocol === true,
              includeQueryString:
                cdn.cacheKeyPolicy?.includeQueryString === true,
            },
          }
        : undefined,
    logConfig: {
      enable: live.logConfig?.enable === true,
      ...(live.logConfig?.enable === true &&
      live.logConfig.sampleRate !== undefined
        ? { sampleRate: live.logConfig.sampleRate }
        : {}),
    },
    description: parseDescription(live.description).description,
  };
};

/**
 * The writable fields as Compute takes them. Without CDN no `cdnPolicy` is
 * sent, as Terraform did: Compute keeps its defaults and `enableCDN: false`
 * alone turns caching off.
 */
const desiredBody = (props: EdgeBackendServiceProps, description: string) => ({
  name: props.name,
  description,
  loadBalancingScheme: props.loadBalancingScheme,
  protocol: props.protocol,
  backends: [{ group: props.backendGroup }],
  logConfig:
    props.logConfig.enable && props.logConfig.sampleRate !== undefined
      ? { enable: true, sampleRate: props.logConfig.sampleRate }
      : { enable: props.logConfig.enable },
  enableCDN: props.cdnPolicy !== undefined,
  ...(props.cdnPolicy === undefined ? {} : { cdnPolicy: props.cdnPolicy }),
});

/** The declared fields the live backend does not match. */
export const backendServiceDrift = (
  props: EdgeBackendServiceProps,
  description: string,
  live: LiveBackendService
): ReadonlyArray<string> => {
  const drift: Array<string> = [];
  if ((live.description ?? "") !== description) drift.push("description");
  if (live.protocol !== props.protocol) drift.push("protocol");
  const groups = (live.backends ?? []).map((backend) =>
    resourcePath(backend.group)
  );
  if (groups.length !== 1 || groups[0] !== resourcePath(props.backendGroup)) {
    drift.push("backends");
  }
  const logEnabled = live.logConfig?.enable === true;
  if (
    logEnabled !== props.logConfig.enable ||
    (props.logConfig.enable &&
      props.logConfig.sampleRate !== undefined &&
      live.logConfig?.sampleRate !== props.logConfig.sampleRate)
  ) {
    drift.push("logConfig");
  }
  if ((live.enableCDN === true) !== (props.cdnPolicy !== undefined)) {
    drift.push("enableCDN");
  }
  const cdn = props.cdnPolicy;
  if (cdn !== undefined) {
    const key = live.cdnPolicy?.cacheKeyPolicy;
    if (
      live.cdnPolicy?.cacheMode !== cdn.cacheMode ||
      (live.cdnPolicy?.negativeCaching === true) !== cdn.negativeCaching ||
      (key?.includeHost === true) !== cdn.cacheKeyPolicy.includeHost ||
      (key?.includeProtocol === true) !== cdn.cacheKeyPolicy.includeProtocol ||
      (key?.includeQueryString === true) !==
        cdn.cacheKeyPolicy.includeQueryString
    ) {
      drift.push("cdnPolicy");
    }
  }
  return drift;
};

const securityPolicyDrift = (
  props: EdgeBackendServiceProps,
  live: LiveBackendService
) => resourcePath(live.securityPolicy) !== resourcePath(props.securityPolicy);

/** Compute REST calls about the backends of one project. */
const makeBackendServiceApi = Effect.fnUntraced(function* () {
  const googleApi = yield* makeGoogleApi();
  const backendServices = (project: string) =>
    `${computeRoot}/projects/${project}/global/backendServices`;

  const send = <A>(
    name: string,
    operation: string,
    request: HttpClientRequest.HttpClientRequest,
    handle: (
      response: HttpClientResponse.HttpClientResponse
    ) => Effect.Effect<A, EdgeBackendServiceRequestFailed> | undefined
  ) => {
    const failed = (status: number | null, reason: string) =>
      new EdgeBackendServiceRequestFailed({
        backendService: name,
        operation,
        status,
        reason,
      });
    return googleApi.call({
      request: request.pipe(HttpClientRequest.acceptJson),
      policy: computeRetry,
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

  const decodeJson =
    <A>(
      decodeBody: (body: unknown) => Effect.Effect<A, unknown>,
      name: string,
      operation: string,
      status: number
    ) =>
    (response: HttpClientResponse.HttpClientResponse) =>
      response.json.pipe(
        Effect.flatMap(decodeBody),
        Effect.mapError(
          () =>
            new EdgeBackendServiceRequestFailed({
              backendService: name,
              operation,
              status,
              reason: "unreadable Compute answer",
            })
        )
      );
  const decodeBackend = Schema.decodeUnknownEffect(LiveBackendService);
  const decodeOperation = Schema.decodeUnknownEffect(ComputeOperation);

  const operationAnswer =
    (name: string, operation: string, accept: ReadonlyArray<number>) =>
    (response: HttpClientResponse.HttpClientResponse) =>
      accept.includes(response.status)
        ? decodeJson(
            decodeOperation,
            name,
            operation,
            response.status
          )(response)
        : undefined;

  return {
    get: (project: string, name: string) =>
      send(
        name,
        "get",
        HttpClientRequest.get(`${backendServices(project)}/${name}`),
        (response) => {
          if (response.status === 404) {
            return Effect.undefined;
          }
          return response.status === 200
            ? decodeJson(decodeBackend, name, "get", 200)(response)
            : undefined;
        }
      ),
    /** The insert's operation, or `conflict` when the name is taken. */
    insert: (project: string, name: string, body: object) =>
      send<"conflict" | LiveOperation>(
        name,
        "insert",
        HttpClientRequest.post(backendServices(project)).pipe(
          HttpClientRequest.bodyJsonUnsafe(body)
        ),
        (response) =>
          response.status === 409
            ? Effect.succeed("conflict" as const)
            : operationAnswer(name, "insert", [200])(response)
      ),
    patch: (project: string, name: string, body: object) =>
      send(
        name,
        "patch",
        HttpClientRequest.patch(`${backendServices(project)}/${name}`).pipe(
          HttpClientRequest.bodyJsonUnsafe(body)
        ),
        operationAnswer(name, "patch", [200])
      ),
    setSecurityPolicy: (project: string, name: string, policy: string) =>
      send(
        name,
        "setSecurityPolicy",
        HttpClientRequest.post(
          `${backendServices(project)}/${name}/setSecurityPolicy`
        ).pipe(HttpClientRequest.bodyJsonUnsafe({ securityPolicy: policy })),
        operationAnswer(name, "setSecurityPolicy", [200])
      ),
    /** The delete's operation, or `gone` when nothing has the name. */
    delete: (project: string, name: string) =>
      send<"gone" | LiveOperation>(
        name,
        "delete",
        HttpClientRequest.delete(`${backendServices(project)}/${name}`),
        (response) =>
          response.status === 404
            ? Effect.succeed("gone" as const)
            : operationAnswer(name, "delete", [200])(response)
      ),
  };
});

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

const settle = (
  project: string,
  operation: LiveOperation,
  options?: { readonly ignore?: ReadonlyArray<string> }
) =>
  waitGlobalOperation(
    project,
    // The waiter reads only the operation's name, status and error.
    operation as Parameters<typeof waitGlobalOperation>[1],
    options
  );

/**
 * The provider of `EdgeBackendService`. It uses the stack's GCP
 * credentials and HTTP client, the same ones the native providers use, and
 * the native Compute global operation waiter.
 */
export const EdgeBackendServiceProvider = Provider.succeed(EdgeBackendService, {
  stables: ["project", "name", "id", "selfLink", "creationTimestamp"],

  diff: Effect.fn(function* ({ news, olds, output }) {
    const previous = olds ?? output;
    if (previous === undefined) {
      return undefined;
    }
    // Identity fields are plain strings; an unresolved one cannot differ yet.
    const next = news as Partial<Record<string, unknown>>;
    const changed = (key: "project" | "name" | "loadBalancingScheme") =>
      typeof next[key] === "string" && next[key] !== previous[key];
    if (changed("project") || changed("name")) {
      return { action: "replace" as const, deleteFirst: false };
    }
    if (changed("loadBalancingScheme")) {
      // The same name cannot exist twice, so the old one goes first.
      return { action: "replace" as const, deleteFirst: true };
    }
    return undefined;
  }),

  read: Effect.fn(function* ({ id, olds, output, previous }) {
    const api = yield* makeBackendServiceApi();
    const project = output?.project ?? olds.project;
    const name = output?.name ?? olds.name;
    const live = yield* api.get(project, name);
    if (live === undefined) {
      return undefined;
    }
    const attributes = toAttributes(project, live);
    const owned =
      (yield* isOwned(id, live)) ||
      (previous !== undefined && previous.selfLink === live.selfLink);
    return owned ? attributes : Unowned(attributes);
  }),

  reconcile: Effect.fn(function* ({ id, news, output }) {
    const api = yield* makeBackendServiceApi();
    const { project, name } = news;
    const description = encodeDescription(
      yield* createInternalLabels(id),
      news.description
    );
    const body = desiredBody(news, description);

    let live = yield* api.get(project, name);
    if (live === undefined) {
      const inserted = yield* api.insert(project, name, body);
      if (inserted !== "conflict") {
        yield* settle(project, inserted);
      }
      live = yield* api.get(project, name);
      if (live === undefined) {
        return yield* new EdgeBackendServiceRequestFailed({
          backendService: name,
          operation: "insert",
          status: null,
          reason: "the backend is missing after its insert",
        });
      }
      // A conflict is success only if the existing backend is ours, as
      // after a retried insert whose first attempt went through.
      if (inserted === "conflict" && !(yield* isOwned(id, live))) {
        return yield* new EdgeBackendServiceUnowned({ backendService: name });
      }
    } else if (output === undefined && !(yield* isOwned(id, live))) {
      // Never take over a foreign backend; adoption arrives with `output`.
      return yield* new EdgeBackendServiceUnowned({ backendService: name });
    }

    if (live.loadBalancingScheme !== news.loadBalancingScheme) {
      return yield* new EdgeBackendServiceNotConverged({
        backendService: name,
        fields: ["loadBalancingScheme"],
      });
    }

    if (backendServiceDrift(news, description, live).length > 0) {
      const patched = yield* api.patch(project, name, {
        ...body,
        fingerprint: live.fingerprint,
      });
      yield* settle(project, patched);
      live = (yield* api.get(project, name)) ?? live;
    }

    if (securityPolicyDrift(news, live)) {
      const attached = yield* api.setSecurityPolicy(
        project,
        name,
        news.securityPolicy
      );
      yield* settle(project, attached);
      live = (yield* api.get(project, name)) ?? live;
    }

    const remaining = [
      ...backendServiceDrift(news, description, live),
      ...(securityPolicyDrift(news, live) ? ["securityPolicy"] : []),
    ];
    if (remaining.length > 0) {
      return yield* new EdgeBackendServiceNotConverged({
        backendService: name,
        fields: remaining,
      });
    }
    return toAttributes(project, live);
  }),

  delete: Effect.fn(function* ({ output }) {
    const api = yield* makeBackendServiceApi();
    const deleted = yield* api.delete(output.project, output.name);
    if (deleted !== "gone") {
      yield* settle(output.project, deleted, {
        ignore: ["RESOURCE_NOT_FOUND"],
      });
    }
  }),
});
