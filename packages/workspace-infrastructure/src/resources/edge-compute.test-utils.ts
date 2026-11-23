import { Credentials } from "@alchemy.run/gcp";
import type * as Provider from "alchemy/Provider";
import type { ResourceLike } from "alchemy/Resource";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

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
export type Call = {
  readonly method: string;
  readonly path: string;
  readonly query: string;
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
  const operations = new Map<string, string>();
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
  const operation = (kind: string) => {
    const name = `operation-${operations.size + 1}`;
    operations.set(name, kind);
    return options.failingAtOnce?.includes(kind)
      ? { name, status: "DONE", ...operationError }
      : { name, status: "RUNNING" };
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
      const kind = operations.get(operationMatch[1] ?? "") ?? "";
      return answer(200, {
        name: operationMatch[1],
        status: "DONE",
        ...(options.failing?.includes(kind) ? operationError : {}),
      });
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
      return answer(200, operation("insert"));
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
      return answer(200, operation("patch"));
    }
    if (method === "DELETE") {
      objects.delete(name);
      return answer(200, operation("delete"));
    }
    if (method !== "POST" || action === undefined) {
      return answer(500);
    }
    const rules = (live.rules ?? []) as ReadonlyArray<Live>;
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
    return answer(200, operation(action));
  };

  const client = HttpClient.make((request) => {
    const url = new URL(request.url);
    const bytes =
      request.body._tag === "Uint8Array" ? request.body.body : undefined;
    const body =
      bytes === undefined
        ? undefined
        : (JSON.parse(new TextDecoder().decode(bytes)) as Live);
    const params = new URLSearchParams(
      request.urlParams.params.map(([key, value]) => [key, String(value)])
    );
    if (!url.pathname.includes("/global/operations/")) {
      calls.push({
        method: request.method,
        path: url.pathname,
        query: params.toString(),
        body,
      });
    }
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        route(request.method, url.pathname, params, body)
      )
    );
  });
  return { client, calls, objects };
};

export type FakeCompute = ReturnType<typeof fakeCompute>;

/**
 * Run a provider's lifecycle against the fake with synthetic credentials
 * and the stack and stage its ownership marker names.
 */
export const runLifecycle = <R extends ResourceLike, A, E>(
  providerLayer: Layer.Layer<Provider.Provider<R>, never, unknown>,
  tag: Provider.Provider<R>,
  fake: FakeCompute,
  use: (provider: Provider.ProviderService<R>) => Effect.Effect<A, E, unknown>
) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      return yield* use((yield* tag) as Provider.ProviderService<R>);
    }).pipe(
      Effect.provide(
        providerLayer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.succeed(HttpClient.HttpClient, fake.client),
              Layer.succeed(
                Credentials,
                Effect.succeed({
                  accessToken: Redacted.make("synthetic-access-token"),
                }) as typeof Credentials.Service
              ),
              Layer.succeed(Stack, { name: stackName } as never),
              Layer.succeed(Stage, stageName)
            )
          )
        ) as Layer.Layer<Provider.Provider<R>>
      )
    ) as Effect.Effect<A, E>
  );

/** The lifecycle fields no edge provider reads. */
export const lifecycleInput = (logicalId: string) => ({
  id: logicalId,
  fqn: logicalId,
  instanceId: "instance",
  session: {} as never,
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
    .find((value) => value !== undefined) as { _tag?: string } | undefined;
  return error?._tag;
};
