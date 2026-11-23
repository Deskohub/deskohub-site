import { describe, expect, test } from "bun:test";
import { Credentials } from "@alchemy.run/gcp";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import {
  EdgeBackendService,
  type EdgeBackendServiceAttributes,
  type EdgeBackendServiceProps,
  EdgeBackendServiceProvider,
} from "./edge-backend-service";

const project = "deskohub-ws-sandbox";
const logicalId = "EdgeDynamicBackend";
const stackName = "DeskohubWorkspaceTest";
const stageName = "test";
// GCP label values are lowercase, so the marker is too.
const ownMarker = `[alchemy alchemy-stack=${stackName.toLowerCase()} alchemy-stage=${stageName} alchemy-id=${logicalId.toLowerCase()}]`;
const foreignMarker = `[alchemy alchemy-stack=other alchemy-stage=${stageName} alchemy-id=${logicalId.toLowerCase()}]`;
const computeRoot = `https://www.googleapis.com/compute/v1/projects/${project}`;
const negLink = `${computeRoot}/regions/europe-west1/networkEndpointGroups/workspace-sandbox-web`;
const policyLink = `${computeRoot}/global/securityPolicies/workspace-sandbox-edge`;
const otherPolicyLink = `${computeRoot}/global/securityPolicies/legacy`;

const dynamicProps: EdgeBackendServiceProps = {
  project,
  name: "workspace-sandbox-dynamic",
  loadBalancingScheme: "EXTERNAL_MANAGED",
  protocol: "HTTPS",
  backendGroup: negLink,
  securityPolicy: policyLink,
  logConfig: { enable: false },
};

const cdnPolicy = {
  cacheMode: "USE_ORIGIN_HEADERS",
  negativeCaching: false,
  cacheKeyPolicy: {
    includeHost: true,
    includeProtocol: true,
    includeQueryString: false,
  },
} as const;

const staticProps: EdgeBackendServiceProps = {
  ...dynamicProps,
  name: "workspace-sandbox-static",
  logConfig: { enable: true, sampleRate: 1 },
  cdnPolicy,
};

type Live = Record<string, unknown>;
type Call = {
  readonly method: string;
  readonly path: string;
  readonly body: Live | undefined;
};

interface FakeOptions {
  /** Backends already in the project. */
  readonly existing?: ReadonlyArray<Live>;
  /** Backends a concurrent insert creates between our GET and insert. */
  readonly appearOnInsert?: ReadonlyArray<Live>;
  /** Operation kinds whose operation finishes with an error. */
  readonly failing?: ReadonlyArray<string>;
}

/** An in-memory Compute API holding global backend services. */
const fakeCompute = (options: FakeOptions = {}) => {
  const backends = new Map<string, Live>(
    (options.existing ?? []).map((live) => [String(live.name), { ...live }])
  );
  const calls: Array<Call> = [];
  const operations = new Map<string, string>();
  let fingerprint = 0;
  const nextFingerprint = () => `fp-${++fingerprint}`;
  const operation = (kind: string) => {
    const name = `operation-${operations.size + 1}`;
    operations.set(name, kind);
    return { name, status: "RUNNING" };
  };
  const answer = (status: number, body?: unknown) =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
    });

  const route = (method: string, path: string, body: Live | undefined) => {
    const operationMatch = path.match(/\/global\/operations\/([^/]+)$/);
    if (operationMatch && method === "GET") {
      const kind = operations.get(operationMatch[1] ?? "") ?? "";
      return answer(200, {
        name: operationMatch[1],
        status: "DONE",
        ...(options.failing?.includes(kind)
          ? {
              error: {
                errors: [{ code: "QUOTA_EXCEEDED", message: "synthetic" }],
              },
            }
          : {}),
      });
    }
    const match = path.match(
      /\/projects\/([^/]+)\/global\/backendServices(?:\/([^/]+))?(?:\/(setSecurityPolicy))?$/
    );
    if (match === null) {
      return answer(500);
    }
    const [, , name, action] = match;
    if (method === "POST" && name === undefined && body !== undefined) {
      for (const live of options.appearOnInsert ?? []) {
        backends.set(String(live.name), { ...live });
      }
      if (backends.has(String(body.name))) {
        return answer(409, { error: { message: "already exists" } });
      }
      backends.set(String(body.name), {
        ...body,
        id: "1234",
        selfLink: `${computeRoot}/global/backendServices/${body.name}`,
        creationTimestamp: "2026-11-23T00:00:00Z",
        fingerprint: nextFingerprint(),
      });
      return answer(200, operation("insert"));
    }
    const live = name === undefined ? undefined : backends.get(name);
    if (live === undefined || name === undefined) {
      return answer(404, { error: { message: "not found" } });
    }
    if (method === "GET") {
      return answer(200, live);
    }
    if (method === "PATCH" && body !== undefined) {
      if (body.fingerprint !== live.fingerprint) {
        return answer(412, { error: { message: "fingerprint mismatch" } });
      }
      const { fingerprint: _sent, ...fields } = body;
      backends.set(name, {
        ...live,
        ...fields,
        fingerprint: nextFingerprint(),
      });
      return answer(200, operation("patch"));
    }
    if (method === "POST" && action === "setSecurityPolicy" && body) {
      backends.set(name, { ...live, securityPolicy: body.securityPolicy });
      return answer(200, operation("setSecurityPolicy"));
    }
    if (method === "DELETE") {
      backends.delete(name);
      return answer(200, operation("delete"));
    }
    return answer(500);
  };

  const client = HttpClient.make((request) => {
    const url = new URL(request.url);
    const bytes =
      request.body._tag === "Uint8Array" ? request.body.body : undefined;
    const body =
      bytes === undefined
        ? undefined
        : (JSON.parse(new TextDecoder().decode(bytes)) as Live);
    if (!url.pathname.includes("/global/operations/")) {
      calls.push({ method: request.method, path: url.pathname, body });
    }
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        route(request.method, url.pathname, body)
      )
    );
  });
  return { client, calls, backends };
};

const lifecycle = Provider.Provider<EdgeBackendService>(
  EdgeBackendService.Type
);

type Lifecycle = Provider.ProviderService<EdgeBackendService>;

const run = <A, E>(
  fake: ReturnType<typeof fakeCompute>,
  use: (provider: Lifecycle) => Effect.Effect<A, E, unknown>
) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      return yield* use((yield* lifecycle) as Lifecycle);
    }).pipe(
      Effect.provide(
        EdgeBackendServiceProvider.pipe(
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
        )
      )
    ) as Effect.Effect<A, E>
  );

const lifecycleInput = {
  id: logicalId,
  fqn: logicalId,
  instanceId: "instance",
  session: {} as never,
  bindings: [],
};

const reconcile = (
  provider: Lifecycle,
  news: EdgeBackendServiceProps,
  output?: EdgeBackendServiceAttributes
) =>
  provider.reconcile({
    ...lifecycleInput,
    news,
    olds: output === undefined ? undefined : news,
    output,
  });

/** The provider implements `read`; a missing one fails the test. */
const readBackend = (
  provider: Lifecycle,
  input: Parameters<NonNullable<Lifecycle["read"]>>[0]
) =>
  provider.read === undefined
    ? Effect.die(new Error("the provider has no read"))
    : provider.read(input);

const mutations = (calls: ReadonlyArray<Call>) =>
  calls
    .filter((call) => call.method !== "GET")
    .map(
      (call) => `${call.method} ${call.path.split("/").slice(-2).join("/")}`
    );

/** A backend as Compute reports it after it converged on `props`. */
const converged = (
  props: EdgeBackendServiceProps,
  description = ownMarker
): Live => ({
  name: props.name,
  id: "1234",
  selfLink: `${computeRoot}/global/backendServices/${props.name}`,
  creationTimestamp: "2026-11-01T00:00:00Z",
  description,
  fingerprint: "fp-existing",
  loadBalancingScheme: props.loadBalancingScheme,
  protocol: props.protocol,
  backends: [{ group: props.backendGroup }],
  securityPolicy: props.securityPolicy,
  logConfig: props.logConfig,
  enableCDN: props.cdnPolicy !== undefined,
  ...(props.cdnPolicy === undefined ? {} : { cdnPolicy: props.cdnPolicy }),
});

const failureTag = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) {
    throw new Error("expected a failure");
  }
  const error = exit.cause.reasons
    .map((reason) => (reason._tag === "Fail" ? reason.error : undefined))
    .find((value) => value !== undefined) as { _tag?: string } | undefined;
  return error?._tag;
};

describe("EdgeBackendService provider", () => {
  test("inserts a dynamic backend without CDN, then attaches Cloud Armor", async () => {
    const fake = fakeCompute();
    const exit = await run(fake, (provider) =>
      reconcile(provider, dynamicProps)
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(mutations(fake.calls)).toEqual([
      "POST global/backendServices",
      "POST workspace-sandbox-dynamic/setSecurityPolicy",
    ]);
    expect(fake.calls.find((call) => call.method === "POST")?.body).toEqual({
      name: "workspace-sandbox-dynamic",
      description: ownMarker,
      loadBalancingScheme: "EXTERNAL_MANAGED",
      protocol: "HTTPS",
      backends: [{ group: negLink }],
      logConfig: { enable: false },
      enableCDN: false,
    });
    expect(
      fake.calls.find((call) => call.path.endsWith("/setSecurityPolicy"))?.body
    ).toEqual({ securityPolicy: policyLink });
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toMatchObject({
        name: "workspace-sandbox-dynamic",
        enableCDN: false,
        cdnPolicy: undefined,
        securityPolicy: policyLink,
        logConfig: { enable: false },
        backendGroups: [negLink],
      });
    }
  });

  test("inserts a static backend with the exact CDN policy and full request logging", async () => {
    const fake = fakeCompute();
    const exit = await run(fake, (provider) =>
      reconcile(provider, staticProps)
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(fake.calls.find((call) => call.method === "POST")?.body).toEqual({
      name: "workspace-sandbox-static",
      description: ownMarker,
      loadBalancingScheme: "EXTERNAL_MANAGED",
      protocol: "HTTPS",
      backends: [{ group: negLink }],
      logConfig: { enable: true, sampleRate: 1 },
      enableCDN: true,
      cdnPolicy,
    });
    if (Exit.isSuccess(exit)) {
      const value = exit.value as EdgeBackendServiceAttributes;
      expect(value.cdnPolicy).toEqual(cdnPolicy);
      expect(value.logConfig).toEqual({ enable: true, sampleRate: 1 });
    }
  });

  test("changes nothing when the live backend already matches", async () => {
    const fake = fakeCompute({ existing: [converged(dynamicProps)] });
    const exit = await run(fake, (provider) =>
      reconcile(provider, dynamicProps)
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(mutations(fake.calls)).toEqual([]);
  });

  test("patches drifted fields under the live fingerprint", async () => {
    const fake = fakeCompute({
      existing: [
        {
          ...converged(staticProps),
          enableCDN: false,
          logConfig: { enable: false },
        },
      ],
    });
    const exit = await run(fake, (provider) =>
      reconcile(provider, staticProps)
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(mutations(fake.calls)).toEqual([
      "PATCH backendServices/workspace-sandbox-static",
    ]);
    const patch = fake.calls.find((call) => call.method === "PATCH")?.body;
    expect(patch).toMatchObject({
      fingerprint: "fp-existing",
      enableCDN: true,
      cdnPolicy,
      logConfig: { enable: true, sampleRate: 1 },
    });
  });

  test("turns CDN off without sending a CDN policy", async () => {
    const fake = fakeCompute({ existing: [converged(staticProps)] });
    const { cdnPolicy: _off, ...withoutCdn } = staticProps;
    const exit = await run(fake, (provider) => reconcile(provider, withoutCdn));
    expect(Exit.isSuccess(exit)).toBe(true);
    const patch = fake.calls.find((call) => call.method === "PATCH")?.body;
    expect(patch?.enableCDN).toBe(false);
    expect(patch && "cdnPolicy" in patch).toBe(false);
    if (Exit.isSuccess(exit)) {
      const value = exit.value as EdgeBackendServiceAttributes;
      expect(value.enableCDN).toBe(false);
      expect(value.cdnPolicy).toBeUndefined();
    }
  });

  test("reattaches Cloud Armor alone when only the policy differs", async () => {
    const fake = fakeCompute({
      existing: [
        { ...converged(dynamicProps), securityPolicy: otherPolicyLink },
      ],
    });
    const exit = await run(fake, (provider) =>
      reconcile(provider, dynamicProps)
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(mutations(fake.calls)).toEqual([
      "POST workspace-sandbox-dynamic/setSecurityPolicy",
    ]);
  });

  test("an insert conflict with our own backend converges it", async () => {
    const fake = fakeCompute({
      appearOnInsert: [
        { ...converged(dynamicProps), securityPolicy: undefined },
      ],
    });
    const exit = await run(fake, (provider) =>
      reconcile(provider, dynamicProps)
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(mutations(fake.calls)).toEqual([
      "POST global/backendServices",
      "POST workspace-sandbox-dynamic/setSecurityPolicy",
    ]);
  });

  test("an insert conflict with a foreign backend fails without touching it", async () => {
    const fake = fakeCompute({
      appearOnInsert: [converged(dynamicProps, foreignMarker)],
    });
    const exit = await run(fake, (provider) =>
      reconcile(provider, dynamicProps)
    );
    expect(failureTag(exit)).toBe("EdgeBackendServiceUnowned");
    expect(mutations(fake.calls)).toEqual(["POST global/backendServices"]);
  });

  test("a create never takes over an unmarked backend of the same name", async () => {
    const fake = fakeCompute({ existing: [converged(dynamicProps, "")] });
    const exit = await run(fake, (provider) =>
      reconcile(provider, dynamicProps)
    );
    expect(failureTag(exit)).toBe("EdgeBackendServiceUnowned");
    expect(mutations(fake.calls)).toEqual([]);
  });

  test("an adopted backend gets the ownership marker", async () => {
    const fake = fakeCompute({ existing: [converged(dynamicProps, "")] });
    const exit = await run(fake, (provider) =>
      Effect.gen(function* () {
        const adopted = yield* readBackend(provider, {
          ...lifecycleInput,
          olds: dynamicProps,
          output: undefined,
        });
        expect(Unowned.is(adopted)).toBe(true);
        return yield* reconcile(
          provider,
          dynamicProps,
          adopted as EdgeBackendServiceAttributes
        );
      })
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(fake.backends.get("workspace-sandbox-dynamic")?.description).toBe(
      ownMarker
    );
  });

  test("a failed operation fails the reconcile", async () => {
    const fake = fakeCompute({ failing: ["insert"] });
    const exit = await run(fake, (provider) =>
      reconcile(provider, dynamicProps)
    );
    expect(failureTag(exit)).toBe("GCP.OperationFailed");
  });

  test("reads owned, foreign and missing backends", async () => {
    const fake = fakeCompute({
      existing: [
        converged(dynamicProps),
        converged(staticProps, foreignMarker),
      ],
    });
    const exit = await run(fake, (provider) =>
      Effect.all([
        readBackend(provider, {
          ...lifecycleInput,
          olds: dynamicProps,
          output: undefined,
        }),
        readBackend(provider, {
          ...lifecycleInput,
          olds: staticProps,
          output: undefined,
        }),
        readBackend(provider, {
          ...lifecycleInput,
          olds: { ...dynamicProps, name: "workspace-sandbox-missing" },
          output: undefined,
        }),
      ])
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      const [owned, foreign, missing] = exit.value;
      expect(owned && Unowned.is(owned)).toBe(false);
      expect(owned?.description).toBeUndefined();
      expect(foreign && Unowned.is(foreign)).toBe(true);
      expect(missing).toBeUndefined();
    }
  });

  test("deletes and waits, and treats a missing backend as gone", async () => {
    const fake = fakeCompute({ existing: [converged(dynamicProps)] });
    const output = {
      project,
      name: "workspace-sandbox-dynamic",
    } as EdgeBackendServiceAttributes;
    const exit = await run(fake, (provider) =>
      Effect.all([
        provider.delete({ ...lifecycleInput, olds: dynamicProps, output }),
        provider.delete({ ...lifecycleInput, olds: dynamicProps, output }),
      ])
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(fake.backends.size).toBe(0);
    expect(mutations(fake.calls)).toEqual([
      "DELETE backendServices/workspace-sandbox-dynamic",
      "DELETE backendServices/workspace-sandbox-dynamic",
    ]);
  });

  test("replaces on identity or scheme changes only", async () => {
    const fake = fakeCompute();
    const diff = (news: EdgeBackendServiceProps) =>
      run(fake, (provider) =>
        Effect.gen(function* () {
          const result = yield* provider.diff?.({
            ...lifecycleInput,
            olds: dynamicProps,
            news,
            oldBindings: [],
            newBindings: [],
            output: undefined,
          }) ?? Effect.undefined;
          return result ?? undefined;
        })
      );
    const renamed = await diff({ ...dynamicProps, name: "workspace-other" });
    const rescheme = await diff({
      ...dynamicProps,
      loadBalancingScheme: "EXTERNAL" as never,
    });
    const reprotocol = await diff({
      ...dynamicProps,
      protocol: "HTTP" as never,
    });
    expect(Exit.isSuccess(renamed) && renamed.value).toEqual({
      action: "replace",
      deleteFirst: false,
    });
    expect(Exit.isSuccess(rescheme) && rescheme.value).toEqual({
      action: "replace",
      deleteFirst: true,
    });
    expect(Exit.isSuccess(reprotocol) && reprotocol.value).toBeUndefined();
  });
});
