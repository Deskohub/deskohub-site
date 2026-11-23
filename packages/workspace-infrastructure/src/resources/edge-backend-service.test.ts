import { describe, expect, test } from "bun:test";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
  EdgeBackendService,
  type EdgeBackendServiceAttributes,
  type EdgeBackendServiceProps,
  EdgeBackendServiceProvider,
} from "./edge-backend-service";
import {
  computeLinkRoot,
  type FakeComputeOptions,
  failureTag,
  fakeCompute as fakeComputeOf,
  foreignMarker as foreignMarkerOf,
  type Live,
  lifecycleInput as lifecycleInputOf,
  mutations,
  ownMarker as ownMarkerOf,
  project,
  runLifecycle,
  withUndeclaredValue,
} from "./edge-compute.test-utils";

const logicalId = "EdgeDynamicBackend";
const ownMarker = ownMarkerOf(logicalId);
const foreignMarker = foreignMarkerOf(logicalId);
const lifecycleInput = lifecycleInputOf(logicalId);
const negLink = `${computeLinkRoot}/regions/europe-west1/networkEndpointGroups/workspace-sandbox-web`;
const policyLink = `${computeLinkRoot}/global/securityPolicies/workspace-sandbox-edge`;
const otherPolicyLink = `${computeLinkRoot}/global/securityPolicies/legacy`;

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

const fakeCompute = (options?: FakeComputeOptions) =>
  fakeComputeOf("backendServices", options);

const lifecycle = Provider.Provider<EdgeBackendService>(
  EdgeBackendService.Type
);
type Lifecycle = Provider.ProviderService<EdgeBackendService>;

const run = <A, E>(
  fake: ReturnType<typeof fakeCompute>,
  use: (provider: Lifecycle) => Effect.Effect<A, E>
) => runLifecycle(EdgeBackendServiceProvider, lifecycle, fake, use);

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

/** The attributes a state file recorded for the dynamic backend. */
const recorded = (id = ""): EdgeBackendServiceAttributes => ({
  project,
  name: "workspace-sandbox-dynamic",
  id,
  selfLink: "",
  creationTimestamp: "",
  loadBalancingScheme: "EXTERNAL_MANAGED",
  protocol: "HTTPS",
  backendGroups: [],
  securityPolicy: undefined,
  enableCDN: false,
  cdnPolicy: undefined,
  logConfig: { enable: false },
  description: undefined,
});

/** A backend as Compute reports it after it converged on `props`. */
const converged = (
  props: EdgeBackendServiceProps,
  description = ownMarker
): Live => ({
  name: props.name,
  id: "1234",
  selfLink: `${computeLinkRoot}/global/backendServices/${props.name}`,
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
      const value = exit.value;
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
      const value = exit.value;
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
    expect(failureTag(exit)).toBe("EdgeComputeResourceUnowned");
    expect(mutations(fake.calls)).toEqual(["POST global/backendServices"]);
  });

  test("a create never takes over an unmarked backend of the same name", async () => {
    const fake = fakeCompute({ existing: [converged(dynamicProps, "")] });
    const exit = await run(fake, (provider) =>
      reconcile(provider, dynamicProps)
    );
    expect(failureTag(exit)).toBe("EdgeComputeResourceUnowned");
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
        if (adopted === undefined) {
          return yield* Effect.die(new Error("the backend was not read"));
        }
        return yield* reconcile(provider, dynamicProps, adopted);
      })
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(fake.objects.get("workspace-sandbox-dynamic")?.description).toBe(
      ownMarker
    );
  });

  test("a failed operation fails the reconcile", async () => {
    const fake = fakeCompute({ failing: ["insert"] });
    const exit = await run(fake, (provider) =>
      reconcile(provider, dynamicProps)
    );
    expect(failureTag(exit)).toBe("EdgeComputeOperationFailed");
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
    const output = recorded();
    const exit = await run(fake, (provider) =>
      Effect.all([
        provider.delete({ ...lifecycleInput, olds: dynamicProps, output }),
        provider.delete({ ...lifecycleInput, olds: dynamicProps, output }),
      ])
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(fake.objects.size).toBe(0);
    // The second delete reads nothing there and sends nothing.
    expect(mutations(fake.calls)).toEqual([
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
    const rescheme = await diff(
      withUndeclaredValue(dynamicProps, "loadBalancingScheme", "EXTERNAL")
    );
    const reprotocol = await diff(
      withUndeclaredValue(dynamicProps, "protocol", "HTTP")
    );
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
  test("an operation already DONE with an error fails the reconcile", async () => {
    const fake = fakeCompute({ failingAtOnce: ["insert"] });
    const exit = await run(fake, (provider) =>
      reconcile(provider, dynamicProps)
    );
    expect(failureTag(exit)).toBe("EdgeComputeOperationFailed");
    expect(mutations(fake.calls)).toEqual(["POST global/backendServices"]);
  });

  test("a delete fails on an operation error other than not found", async () => {
    const output = recorded();
    const remove = (options: FakeComputeOptions) =>
      run(
        fakeCompute({ existing: [converged(dynamicProps)], ...options }),
        (provider) =>
          provider.delete({ ...lifecycleInput, olds: dynamicProps, output })
      );
    expect(failureTag(await remove({ failingAtOnce: ["delete"] }))).toBe(
      "EdgeComputeOperationFailed"
    );
    expect(
      Exit.isSuccess(
        await remove({
          failingAtOnce: ["delete"],
          failureCode: "RESOURCE_NOT_FOUND",
        })
      )
    ).toBe(true);
  });

  test("rereads and retries a PATCH whose fingerprint went stale", async () => {
    const fake = fakeCompute({
      existing: [{ ...converged(dynamicProps), logConfig: { enable: true } }],
      stalePatches: 1,
    });
    const exit = await run(fake, (provider) =>
      reconcile(provider, dynamicProps)
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    const patches = fake.calls.filter((call) => call.method === "PATCH");
    expect(patches).toHaveLength(2);
    expect(patches[1]?.body?.name).toBeUndefined();
    expect(patches[1]?.body?.loadBalancingScheme).toBeUndefined();
    expect(fake.objects.get("workspace-sandbox-dynamic")?.logConfig).toEqual({
      enable: false,
    });
  });
  test("never changes or deletes a same-name backend someone else recreated", async () => {
    const admitted = recorded("1234");
    const recreated = {
      ...converged(dynamicProps, ""),
      id: "9999",
      logConfig: { enable: true },
    };
    const fake = fakeCompute({ existing: [recreated] });
    const exit = await run(fake, (provider) =>
      Effect.gen(function* () {
        const update = yield* Effect.exit(
          reconcile(provider, dynamicProps, admitted)
        );
        yield* provider.delete({
          ...lifecycleInput,
          olds: dynamicProps,
          output: admitted,
        });
        return update;
      })
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(failureTag(exit.value)).toBe("EdgeComputeResourceUnowned");
    }
    expect(mutations(fake.calls)).toEqual([]);
    expect(fake.objects.get("workspace-sandbox-dynamic")?.id).toBe("9999");
  });

  test("updates its own backend recreated under a new ID", async () => {
    const fake = fakeCompute({
      existing: [
        { ...converged(dynamicProps), id: "9999", logConfig: { enable: true } },
      ],
    });
    const exit = await run(fake, (provider) =>
      reconcile(provider, dynamicProps, recorded("1234"))
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(mutations(fake.calls)).toEqual([
      "PATCH backendServices/workspace-sandbox-dynamic",
    ]);
  });
  test("a retried delete never removes a same-name replacement", async () => {
    const replacement = {
      ...converged(dynamicProps, ""),
      id: "9999",
    };
    const fake = fakeCompute({
      existing: [converged(dynamicProps)],
      lostAnswers: ["delete"],
      replaceAfter: { kind: "delete", with: replacement },
    });
    const exit = await run(fake, (provider) =>
      provider.delete({
        ...lifecycleInput,
        olds: dynamicProps,
        output: recorded("1234"),
      })
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    const deletes = fake.calls.filter((call) => call.method === "DELETE");
    expect(deletes).toHaveLength(2);
    expect(deletes[1]?.requestId).toBe(deletes[0]?.requestId ?? "");
    expect(fake.objects.get("workspace-sandbox-dynamic")?.id).toBe("9999");
  });

  test("a retried insert is applied once", async () => {
    const fake = fakeCompute({ lostAnswers: ["insert"] });
    const exit = await run(fake, (provider) =>
      reconcile(provider, dynamicProps)
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    const inserts = fake.calls.filter(
      (call) => call.method === "POST" && call.path.endsWith("/backendServices")
    );
    expect(inserts).toHaveLength(2);
    expect(inserts[1]?.requestId).toBe(inserts[0]?.requestId ?? "");
  });

  test("an insert never admits a replacement it did not create", async () => {
    const fake = fakeCompute({
      replaceAfter: {
        kind: "insert",
        with: { ...converged(dynamicProps, ""), id: "9999" },
      },
    });
    const exit = await run(fake, (provider) =>
      reconcile(provider, dynamicProps)
    );
    expect(failureTag(exit)).toBe("EdgeComputeResourceUnowned");
    expect(mutations(fake.calls)).toEqual(["POST global/backendServices"]);
  });

  test("waits out an operation that is not yet visible to its first polls", async () => {
    const fake = fakeCompute({
      existing: [{ ...converged(staticProps), enableCDN: false }],
      unknownOperationPolls: 2,
    });
    const exit = await run(fake, (provider) =>
      reconcile(provider, staticProps)
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(mutations(fake.calls)).toEqual([
      "PATCH backendServices/workspace-sandbox-static",
    ]);
    expect([...fake.operationPolls]).toEqual([["operation-1", 3]]);
  });

  test("polls a running operation again until it is done", async () => {
    const fake = fakeCompute({
      existing: [{ ...converged(staticProps), enableCDN: false }],
      runningOperationPolls: 1,
    });
    const exit = await run(fake, (provider) =>
      reconcile(provider, staticProps)
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect([...fake.operationPolls]).toEqual([["operation-1", 2]]);
  });
});
