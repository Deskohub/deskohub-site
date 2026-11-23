import { Credentials } from "@alchemy.run/gcp";
import type * as Provider from "alchemy/Provider";
import { noopSession } from "alchemy/Report";
import type { ResourceLike } from "alchemy/Resource";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export const project = "deskohub-ws-sandbox";
export const computeLinkRoot = `https://www.googleapis.com/compute/v1/projects/${project}`;
const stackName = "DeskohubWorkspaceTest";
const stageName = "test";

/** The description prefix this stack writes for a logical ID. */
export const ownMarker = (logicalId: string) =>
  // GCP label values are lowercase, so the marker is too.
  `[alchemy alchemy-stack=${stackName.toLowerCase()} alchemy-stage=${stageName} alchemy-id=${logicalId.toLowerCase()}]`;

/** The same logical ID owned by another stack. */
export const foreignMarker = (logicalId: string) =>
  `[alchemy alchemy-stack=other alchemy-stage=${stageName} alchemy-id=${logicalId.toLowerCase()}]`;

export type Live = Record<string, unknown>;

const LiveObject = Schema.Record(Schema.String, Schema.Unknown);
const decodeLiveObjects = Schema.decodeUnknownSync(Schema.Array(LiveObject));
const decodeLiveJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(LiveObject)
);

/** The rules of a live security policy; none when it has no rules. */
export const liveRules = (live: Live | undefined): ReadonlyArray<Live> =>
  decodeLiveObjects(live?.rules ?? []);

/**
 * A copy of `props` whose `key` holds a value its type rules out, for
 * checking how a provider treats input it never declares.
 */
export const withUndeclaredValue = <P extends object>(
  props: P,
  key: keyof P & string,
  value: unknown
): P => {
  const copy = { ...props };
  Reflect.set(copy, key, value);
  return copy;
};
export type Call = {
  readonly method: string;
  readonly path: string;
  /** Query parameters other than the request ID. */
  readonly query: string;
  readonly requestId: string | null;
  readonly body: Live | undefined;
};

export interface FakeComputeOptions {
  /** Objects already in the collection. */
  readonly existing?: ReadonlyArray<Live>;
  /** Objects a concurrent insert creates between our GET and insert. */
  readonly appearOnInsert?: ReadonlyArray<Live>;
  /** Operation kinds whose operation finishes with an error when polled. */
  readonly failing?: ReadonlyArray<string>;
  /** Operation kinds answered already DONE with an error. */
  readonly failingAtOnce?: ReadonlyArray<string>;
  /** The Compute error code a failed operation reports. */
  readonly failureCode?: string;
  /** PATCHes whose fingerprint a concurrent writer changes first. */
  readonly stalePatches?: number;
  /** Operation kinds applied once but answered 503, so the client retries. */
  readonly lostAnswers?: ReadonlyArray<string>;
  /** Right after an operation of `kind`, someone recreates the object. */
  readonly replaceAfter?: { readonly kind: string; readonly with: Live };
  /** Polls of a fresh operation answered 404, as if not yet visible. */
  readonly unknownOperationPolls?: number;
  /** Polls of an operation answered RUNNING before it reports DONE. */
  readonly runningOperationPolls?: number;
}

type Collection = "backendServices" | "securityPolicies";

/** An in-memory Compute API holding one global collection. */
export const fakeCompute = (
  collection: Collection,
  options: FakeComputeOptions = {}
) => {
  const objects = new Map<string, Live>(
    (options.existing ?? []).map((live) => [String(live.name), { ...live }])
  );
  const calls: Array<Call> = [];
  const answered = new Map<string, Live>();
  const lostAnswers = new Set(options.lostAnswers ?? []);
  let replaceAfter = options.replaceAfter;
  const operations = new Map<string, string>();
  const operationPolls = new Map<string, number>();
  let fingerprint = 0;
  let stalePatches = options.stalePatches ?? 0;
  const nextFingerprint = () => `fp-${++fingerprint}`;
  const operationError = {
    error: {
      errors: [
        { code: options.failureCode ?? "QUOTA_EXCEEDED", message: "synthetic" },
      ],
    },
  };
  type Applied = { readonly kind: string; readonly body: Live };
  const applied: Array<Applied> = [];
  const operation = (kind: string, targetId: unknown) => {
    const name = `operation-${operations.size + 1}`;
    operations.set(name, kind);
    const body = {
      name,
      targetId: String(targetId),
      ...(options.failingAtOnce?.includes(kind)
        ? { status: "DONE", ...operationError }
        : { status: "RUNNING" }),
    };
    applied.push({ kind, body });
    return body;
  };
  const pollOperation = (name: string) => {
    const polls = (operationPolls.get(name) ?? 0) + 1;
    operationPolls.set(name, polls);
    const unknownPolls = options.unknownOperationPolls ?? 0;
    if (polls <= unknownPolls) {
      return answer(404, { error: { message: "operation not found" } });
    }
    if (polls <= unknownPolls + (options.runningOperationPolls ?? 0)) {
      return answer(200, { name, status: "RUNNING" });
    }
    const kind = operations.get(name) ?? "";
    return answer(200, {
      name,
      status: "DONE",
      ...(options.failing?.includes(kind) ? operationError : {}),
    });
  };
  const answer = (status: number, body?: unknown) =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
    });
  const touch = (name: string, live: Live, changes: Live) =>
    objects.set(name, { ...live, ...changes, fingerprint: nextFingerprint() });

  const route = (
    method: string,
    path: string,
    params: URLSearchParams,
    body: Live | undefined
  ) => {
    const operationMatch = path.match(/\/global\/operations\/([^/]+)$/);
    if (operationMatch && method === "GET") {
      return pollOperation(operationMatch[1] ?? "");
    }
    const match = path.match(
      new RegExp(`/global/${collection}(?:/([^/]+))?(?:/([A-Za-z]+))?$`)
    );
    if (match === null) {
      return answer(500);
    }
    const [, name, action] = match;
    if (method === "POST" && name === undefined && body !== undefined) {
      for (const live of options.appearOnInsert ?? []) {
        objects.set(String(live.name), { ...live });
      }
      if (objects.has(String(body.name))) {
        return answer(409, { error: { message: "already exists" } });
      }
      touch(
        String(body.name),
        {},
        {
          ...body,
          id: "1234",
          selfLink: `${computeLinkRoot}/global/${collection}/${body.name}`,
          creationTimestamp: "2026-11-23T00:00:00Z",
        }
      );
      return answer(
        200,
        operation("insert", objects.get(String(body.name))?.id)
      );
    }
    const live = name === undefined ? undefined : objects.get(name);
    if (live === undefined || name === undefined) {
      return answer(404, { error: { message: "not found" } });
    }
    if (method === "GET") {
      return answer(200, live);
    }
    if (method === "PATCH" && body !== undefined) {
      if (stalePatches > 0) {
        stalePatches--;
        touch(name, live, {});
        return answer(412, { error: { message: "fingerprint mismatch" } });
      }
      if (body.fingerprint !== live.fingerprint) {
        return answer(412, { error: { message: "fingerprint mismatch" } });
      }
      const { fingerprint: _sent, ...fields } = body;
      touch(name, live, fields);
      return answer(200, operation("patch", live.id));
    }
    if (method === "DELETE") {
      objects.delete(name);
      return answer(200, operation("delete", live.id));
    }
    if (method !== "POST" || action === undefined) {
      return answer(500);
    }
    const rules = liveRules(live);
    const priority = Number(params.get("priority"));
    switch (action) {
      case "setSecurityPolicy":
        touch(name, live, { securityPolicy: body?.securityPolicy });
        break;
      case "addRule":
        touch(name, live, { rules: [...rules, body] });
        break;
      case "patchRule":
        touch(name, live, {
          rules: rules.map((rule) =>
            rule.priority === priority ? { ...body } : rule
          ),
        });
        break;
      case "removeRule":
        touch(name, live, {
          rules: rules.filter((rule) => rule.priority !== priority),
        });
        break;
      default:
        return answer(500);
    }
    return answer(200, operation(action, live.id));
  };

  const client = HttpClient.make((request) => {
    const url = new URL(request.url);
    const bytes =
      request.body._tag === "Uint8Array" ? request.body.body : undefined;
    const body =
      bytes === undefined
        ? undefined
        : decodeLiveJson(new TextDecoder().decode(bytes));
    const params = new URLSearchParams(
      request.urlParams.params.map(([key, value]) => [key, String(value)])
    );
    const requestId = params.get("requestId");
    params.delete("requestId");
    if (!url.pathname.includes("/global/operations/")) {
      calls.push({
        method: request.method,
        path: url.pathname,
        query: params.toString(),
        requestId,
        body,
      });
    }
    const respond = (response: Response) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, response));
    // A repeated request ID gets the original operation, applied once.
    const original = requestId === null ? undefined : answered.get(requestId);
    if (original !== undefined) {
      return respond(answer(200, original));
    }
    const appliedBefore = applied.length;
    const response = route(request.method, url.pathname, params, body);
    const started = applied.at(appliedBefore);
    if (started === undefined) {
      return respond(response);
    }
    if (requestId !== null) {
      answered.set(requestId, started.body);
    }
    if (replaceAfter?.kind === started.kind) {
      objects.set(String(replaceAfter.with.name), { ...replaceAfter.with });
      replaceAfter = undefined;
    }
    if (lostAnswers.has(started.kind)) {
      lostAnswers.delete(started.kind);
      return respond(answer(503));
    }
    return respond(response);
  });
  return { client, calls, objects, operationPolls };
};

export type FakeCompute = ReturnType<typeof fakeCompute>;

/** The services the edge providers read while they run. */
type LifecycleServices = HttpClient.HttpClient | Credentials | Stack | Stage;

/**
 * Run a provider's lifecycle against the fake with synthetic credentials
 * and the stack and stage its ownership marker names.
 */
export const runLifecycle = <R extends ResourceLike, A, E>(
  providerLayer: Layer.Layer<Provider.Provider<R>, never, LifecycleServices>,
  tag: Provider.Provider<R>,
  fake: FakeCompute,
  use: (
    provider: Provider.ProviderService<R>
  ) => Effect.Effect<A, E, LifecycleServices>
) => {
  const services = Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, fake.client),
    Layer.succeed(
      Credentials,
      Effect.succeed({
        accessToken: Redacted.make("synthetic-access-token"),
      })
    ),
    Layer.succeed(Stack, {
      name: stackName,
      stage: stageName,
      resources: {},
      bindings: {},
      actions: {},
    }),
    Layer.succeed(Stage, stageName)
  );
  return Effect.runPromiseExit(
    Effect.gen(function* () {
      return yield* use(yield* tag);
    }).pipe(Effect.provide(providerLayer.pipe(Layer.provideMerge(services))))
  );
};

/** The lifecycle fields no edge provider reads. */
export const lifecycleInput = (logicalId: string) => ({
  id: logicalId,
  fqn: logicalId,
  instanceId: "instance",
  session: noopSession,
  bindings: [],
});

/** Mutating calls as `METHOD last/two` path segments, with any query. */
export const mutations = (calls: ReadonlyArray<Call>) =>
  calls
    .filter((call) => call.method !== "GET")
    .map(
      (call) =>
        `${call.method} ${call.path.split("/").slice(-2).join("/")}${call.query ? `?${call.query}` : ""}`
    );

/** The tag of the failure an exit ended with. */
export const failureTag = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) {
    throw new Error("expected a failure");
  }
  const error = exit.cause.reasons
    .map((reason) => (reason._tag === "Fail" ? reason.error : undefined))
    .find((value) => value !== undefined);
  return typeof error === "object" && error !== null && "_tag" in error
    ? error._tag
    : undefined;
};
