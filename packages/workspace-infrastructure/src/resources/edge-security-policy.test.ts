import { describe, expect, test } from "bun:test";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
  computeLinkRoot,
  type FakeComputeOptions,
  failureTag,
  fakeCompute,
  foreignMarker,
  type Live,
  lifecycleInput as lifecycleInputOf,
  liveRules,
  mutations,
  ownMarker as ownMarkerOf,
  project,
  runLifecycle,
  withUndeclaredValue,
} from "./edge-compute.test-utils";
import {
  EdgeSecurityPolicy,
  type EdgeSecurityPolicyAttributes,
  type EdgeSecurityPolicyProps,
  EdgeSecurityPolicyProvider,
  type EdgeSecurityPolicyRule,
} from "./edge-security-policy";

const logicalId = "EdgeSecurityPolicy";
const lifecycleInput = lifecycleInputOf(logicalId);
const description = "Workspace sandbox edge policy";
const ownDescription = `${ownMarkerOf(logicalId)}\n${description}`;

const wafRule = (preview: boolean): EdgeSecurityPolicyRule => ({
  action: "deny(403)",
  priority: 1000,
  preview,
  description: "Preconfigured SQL injection rules",
  match: {
    expr: {
      expression:
        "evaluatePreconfiguredWaf('sqli-v33-stable', {'sensitivity': 1})",
    },
  },
});

const throttleLimits = {
  conformAction: "allow",
  exceedAction: "deny(429)",
  enforceOnKey: "IP",
  rateLimitThreshold: { count: 120, intervalSec: 60 },
} satisfies EdgeSecurityPolicyRule["rateLimitOptions"];

const throttleRule: EdgeSecurityPolicyRule = {
  action: "throttle",
  priority: 2000,
  preview: false,
  description: "Throttle auth endpoints per client IP",
  match: { expr: { expression: "request.path.startsWith('/api/auth/')" } },
  rateLimitOptions: throttleLimits,
};

const defaultRule: EdgeSecurityPolicyRule = {
  action: "allow",
  priority: 2147483647,
  preview: false,
  description: "Default allow",
  match: { versionedExpr: "SRC_IPS_V1", config: { srcIpRanges: ["*"] } },
};

const policyProps = (preview: boolean): EdgeSecurityPolicyProps => ({
  project,
  name: "workspace-sandbox-edge",
  description,
  type: "CLOUD_ARMOR",
  rules: [wafRule(preview), throttleRule, defaultRule],
});

/** A policy as Compute reports it: false booleans are left out. */
/** The attributes a state file recorded for the edge policy. */
const recorded = (id = ""): EdgeSecurityPolicyAttributes => ({
  project,
  name: "workspace-sandbox-edge",
  id,
  selfLink: "",
  creationTimestamp: "",
  type: "CLOUD_ARMOR",
  description: undefined,
  rules: [],
});

const liveRule = (rule: EdgeSecurityPolicyRule): Live => {
  const { preview, ...rest } = rule;
  return preview
    ? { ...rule }
    : { ...rest, kind: "compute#securityPolicyRule" };
};

const converged = (
  props: EdgeSecurityPolicyProps,
  liveDescription = ownDescription
): Live => ({
  name: props.name,
  id: "5678",
  selfLink: `${computeLinkRoot}/global/securityPolicies/${props.name}`,
  creationTimestamp: "2026-11-01T00:00:00Z",
  description: liveDescription,
  fingerprint: "fp-existing",
  type: props.type,
  rules: props.rules.map(liveRule),
});

const fake = (options?: FakeComputeOptions) =>
  fakeCompute("securityPolicies", options);

const lifecycle = Provider.Provider<EdgeSecurityPolicy>(
  EdgeSecurityPolicy.Type
);
type Lifecycle = Provider.ProviderService<EdgeSecurityPolicy>;

const run = <A, E>(
  compute: ReturnType<typeof fake>,
  use: (provider: Lifecycle) => Effect.Effect<A, E>
) => runLifecycle(EdgeSecurityPolicyProvider, lifecycle, compute, use);

const reconcile = (
  provider: Lifecycle,
  news: EdgeSecurityPolicyProps,
  output?: EdgeSecurityPolicyAttributes
) =>
  provider.reconcile({
    ...lifecycleInput,
    news,
    olds: output === undefined ? undefined : news,
    output,
  });

const readPolicy = (provider: Lifecycle, olds: EdgeSecurityPolicyProps) =>
  provider.read === undefined
    ? Effect.die(new Error("the provider has no read"))
    : provider.read({ ...lifecycleInput, olds, output: undefined });

describe("EdgeSecurityPolicy provider", () => {
  test("inserts the policy with every rule and preview sent explicitly", async () => {
    const compute = fake();
    const exit = await run(compute, (provider) =>
      reconcile(provider, policyProps(true))
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(mutations(compute.calls)).toEqual(["POST global/securityPolicies"]);
    const inserted = compute.calls[1]?.body;
    expect(inserted).toEqual({
      name: "workspace-sandbox-edge",
      description: ownDescription,
      type: "CLOUD_ARMOR",
      rules: [wafRule(true), throttleRule, defaultRule],
    });
  });

  test("changes nothing when the live policy already matches", async () => {
    const compute = fake({ existing: [converged(policyProps(true))] });
    const exit = await run(compute, (provider) =>
      reconcile(provider, policyProps(true))
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(mutations(compute.calls)).toEqual([]);
  });

  test("takes a WAF rule out of preview with an explicit false", async () => {
    const compute = fake({ existing: [converged(policyProps(true))] });
    const exit = await run(compute, (provider) =>
      reconcile(provider, policyProps(false))
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(mutations(compute.calls)).toEqual([
      "POST workspace-sandbox-edge/patchRule?priority=1000",
    ]);
    const patch = compute.calls.find((call) =>
      call.path.endsWith("/patchRule")
    )?.body;
    expect(patch?.preview).toBe(false);
  });

  test("adds missing, patches changed and removes undeclared rules", async () => {
    const live = converged(policyProps(true));
    const compute = fake({
      existing: [
        {
          ...live,
          rules: [
            liveRule({
              ...throttleRule,
              rateLimitOptions: {
                ...throttleLimits,
                rateLimitThreshold: { count: 60, intervalSec: 60 },
              },
            }),
            liveRule({ ...defaultRule, priority: 3000 }),
            liveRule(defaultRule),
          ],
        },
      ],
    });
    const exit = await run(compute, (provider) =>
      reconcile(provider, policyProps(true))
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(mutations(compute.calls)).toEqual([
      "POST workspace-sandbox-edge/addRule",
      "POST workspace-sandbox-edge/patchRule?priority=2000",
      "POST workspace-sandbox-edge/removeRule?priority=3000",
    ]);
  });

  test("an adopted unmarked policy gets the ownership marker", async () => {
    const compute = fake({
      existing: [converged(policyProps(true), description)],
    });
    const exit = await run(compute, (provider) =>
      Effect.gen(function* () {
        const adopted = yield* readPolicy(provider, policyProps(true));
        expect(adopted !== undefined && Unowned.is(adopted)).toBe(true);
        if (adopted === undefined) {
          return yield* Effect.die(new Error("the policy was not read"));
        }
        return yield* reconcile(provider, policyProps(true), adopted);
      })
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(mutations(compute.calls)).toEqual([
      "PATCH securityPolicies/workspace-sandbox-edge",
    ]);
    expect(compute.objects.get("workspace-sandbox-edge")?.description).toBe(
      ownDescription
    );
  });

  test("never takes over a foreign policy", async () => {
    const created = fake({
      existing: [converged(policyProps(true), foreignMarker(logicalId))],
    });
    expect(
      failureTag(
        await run(created, (provider) => reconcile(provider, policyProps(true)))
      )
    ).toBe("EdgeComputeResourceUnowned");
    const raced = fake({
      appearOnInsert: [converged(policyProps(true), foreignMarker(logicalId))],
    });
    expect(
      failureTag(
        await run(raced, (provider) => reconcile(provider, policyProps(true)))
      )
    ).toBe("EdgeComputeResourceUnowned");
    expect(mutations(raced.calls)).toEqual(["POST global/securityPolicies"]);
  });

  test("a rule operation that fails fails the reconcile", async () => {
    const compute = fake({
      existing: [converged(policyProps(true))],
      failingAtOnce: ["patchRule"],
    });
    const exit = await run(compute, (provider) =>
      reconcile(provider, policyProps(false))
    );
    expect(failureTag(exit)).toBe("EdgeComputeOperationFailed");
  });

  test("deletes and treats a missing policy as gone", async () => {
    const compute = fake({ existing: [converged(policyProps(true))] });
    const output = recorded();
    const exit = await run(compute, (provider) =>
      Effect.all([
        provider.delete({ ...lifecycleInput, olds: policyProps(true), output }),
        provider.delete({ ...lifecycleInput, olds: policyProps(true), output }),
      ])
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(compute.objects.size).toBe(0);
  });

  test("replaces on identity or type changes only", async () => {
    const compute = fake();
    const diff = (news: EdgeSecurityPolicyProps) =>
      run(compute, (provider) =>
        provider.diff === undefined
          ? Effect.undefined
          : provider
              .diff({
                ...lifecycleInput,
                olds: policyProps(true),
                news,
                oldBindings: [],
                newBindings: [],
                output: undefined,
              })
              .pipe(Effect.map((result) => result ?? undefined))
      );
    const renamed = await diff({ ...policyProps(true), name: "other" });
    const retyped = await diff(
      withUndeclaredValue(policyProps(true), "type", "CLOUD_ARMOR_EDGE")
    );
    const rerules = await diff(policyProps(false));
    expect(Exit.isSuccess(renamed) && renamed.value).toEqual({
      action: "replace",
      deleteFirst: false,
    });
    expect(Exit.isSuccess(retyped) && retyped.value).toEqual({
      action: "replace",
      deleteFirst: true,
    });
    expect(Exit.isSuccess(rerules) && rerules.value).toBeUndefined();
  });
  test("clears WAF exclusions the edge never declares", async () => {
    const live = converged(policyProps(true));
    const rules = liveRules(live);
    const compute = fake({
      existing: [
        {
          ...live,
          rules: rules.map((rule) =>
            rule.priority === 1000
              ? {
                  ...rule,
                  preconfiguredWafConfig: {
                    exclusions: [{ targetRuleSet: "sqli-v33-stable" }],
                  },
                }
              : rule
          ),
        },
      ],
    });
    const exit = await run(compute, (provider) =>
      reconcile(provider, policyProps(true))
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(mutations(compute.calls)).toEqual([
      "POST workspace-sandbox-edge/patchRule?priority=1000",
    ]);
    const patch = compute.calls.find((call) =>
      call.path.endsWith("/patchRule")
    )?.body;
    expect(patch?.preconfiguredWafConfig).toEqual({ exclusions: [] });
  });

  test("an insert conflict with its own policy converges it", async () => {
    const compute = fake({ appearOnInsert: [converged(policyProps(true))] });
    const exit = await run(compute, (provider) =>
      reconcile(provider, policyProps(false))
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(mutations(compute.calls)).toEqual([
      "POST global/securityPolicies",
      "POST workspace-sandbox-edge/patchRule?priority=1000",
    ]);
  });

  test("never changes or deletes a same-name policy someone else recreated", async () => {
    const admitted = recorded("5678");
    const compute = fake({
      existing: [{ ...converged(policyProps(true), description), id: "9999" }],
    });
    const exit = await run(compute, (provider) =>
      Effect.gen(function* () {
        const update = yield* Effect.exit(
          reconcile(provider, policyProps(false), admitted)
        );
        yield* provider.delete({
          ...lifecycleInput,
          olds: policyProps(true),
          output: admitted,
        });
        return update;
      })
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(failureTag(exit.value)).toBe("EdgeComputeResourceUnowned");
    }
    expect(mutations(compute.calls)).toEqual([]);
    expect(compute.objects.size).toBe(1);
  });
  test("stops before writing rules to a policy replaced mid-reconcile", async () => {
    const compute = fake({
      existing: [converged(policyProps(true), description)],
      replaceAfter: {
        kind: "patch",
        with: { ...converged(policyProps(true), description), id: "9999" },
      },
    });
    const exit = await run(compute, (provider) =>
      reconcile(provider, policyProps(false), recorded("5678"))
    );
    expect(failureTag(exit)).toBe("EdgeComputeResourceUnowned");
    expect(mutations(compute.calls)).toEqual([
      "PATCH securityPolicies/workspace-sandbox-edge",
    ]);
  });

  test("an insert never admits a replacement it did not create", async () => {
    const compute = fake({
      replaceAfter: {
        kind: "insert",
        with: { ...converged(policyProps(true), description), id: "9999" },
      },
    });
    const exit = await run(compute, (provider) =>
      reconcile(provider, policyProps(true))
    );
    expect(failureTag(exit)).toBe("EdgeComputeResourceUnowned");
    expect(mutations(compute.calls)).toEqual(["POST global/securityPolicies"]);
  });
  test("never replays a rule write against a policy replaced after a lost answer", async () => {
    const replacement = {
      ...converged(policyProps(true), description),
      id: "9999",
    };
    const compute = fake({
      existing: [converged(policyProps(true))],
      lostAnswers: ["patchRule"],
      replaceAfter: { kind: "patchRule", with: replacement },
    });
    const exit = await run(compute, (provider) =>
      reconcile(provider, policyProps(false), recorded("5678"))
    );
    expect(failureTag(exit)).toBe("EdgeComputeResourceUnowned");
    const patchRules = compute.calls.filter((call) =>
      call.path.endsWith("/patchRule")
    );
    expect(patchRules).toHaveLength(1);
    expect(patchRules[0]?.requestId).toBeNull();
    const rules = liveRules(compute.objects.get("workspace-sandbox-edge"));
    expect(rules.find((rule) => rule.priority === 1000)?.preview).toBe(true);
  });

  test("rereads the rules after a lost answer instead of resending", async () => {
    const compute = fake({
      existing: [converged(policyProps(true))],
      lostAnswers: ["patchRule"],
    });
    const exit = await run(compute, (provider) =>
      reconcile(provider, policyProps(false))
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(mutations(compute.calls)).toEqual([
      "POST workspace-sandbox-edge/patchRule?priority=1000",
    ]);
  });
});
