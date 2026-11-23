import { describe, expect, test } from "bun:test";
import * as Storage from "@alchemy.run/gcp/Storage";
import { isOutput } from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
  decodeWorkspaceStackConfig,
  plainHttpEdgeProject,
  type WorkspaceEdgeConfig,
  type WorkspaceStackConfig,
} from "./config/stack-config";
import {
  sandboxConfigInput,
  sandboxConfigInputIn,
} from "./config/stack-config.test-utils";
import {
  declareWorkspaceEdge,
  edgeStaticAssetPaths,
  tokenRouteExclusionFilter,
} from "./resources/edge-declarations";
import { evaluate } from "./stack-evaluation.test-utils";

const domains = ["workspace.example.com"];

const decode = (input: unknown) =>
  Effect.runSyncExit(decodeWorkspaceStackConfig(input));

const decoded = (input: unknown): WorkspaceStackConfig => {
  const exit = decode(input);
  if (Exit.isFailure(exit)) {
    throw new Error("expected the config to decode");
  }
  return exit.value;
};

const rejection = (input: unknown) => {
  const exit = decode(input);
  if (Exit.isSuccess(exit)) {
    throw new Error("expected the config to be rejected");
  }
  const reason = exit.cause.reasons.find((entry) => entry._tag === "Fail");
  return reason?._tag === "Fail"
    ? (reason.error as { reason: string; paths: ReadonlyArray<string> })
    : undefined;
};

/** The approved sandbox project, where plain HTTP is allowed. */
const proofInput = sandboxConfigInputIn(plainHttpEdgeProject);
const { budget: _budget, ...sharedInput } = sandboxConfigInput;

const httpsConfig = decoded({ ...sandboxConfigInput, edge: { domains } });
const plainHttpConfig = decoded({
  ...proofInput,
  edge: {
    domains: [],
    enableHttps: false,
    staticCdnEnabled: false,
    wafPreview: true,
  },
});

const edgeOf = (config: WorkspaceStackConfig): WorkspaceEdgeConfig => {
  if (config.edge === undefined) {
    throw new Error("expected an edge");
  }
  return config.edge;
};

const declare = (
  config: WorkspaceStackConfig,
  overrides: Partial<WorkspaceEdgeConfig> = {},
  webServiceId: Parameters<typeof declareWorkspaceEdge>[2] = "workspace-web"
) =>
  evaluate(
    declareWorkspaceEdge(
      config,
      { ...edgeOf(config), ...overrides },
      webServiceId
    )
  );

const typesOf = (resources: Record<string, { readonly Type: string }>) =>
  Object.fromEntries(
    Object.entries(resources).map(([id, entry]) => [id, entry.Type])
  );

describe("edge configuration", () => {
  test("defaults HTTPS on, CDN off, WAF in preview and 120 auth requests a minute", () => {
    expect(httpsConfig.edge).toEqual({
      domains,
      enableHttps: true,
      staticCdnEnabled: false,
      wafPreview: true,
      authRateLimitPerMinute: 120,
    });
  });

  test("allows plain HTTP only for the sandbox stage in the approved project", () => {
    expect(plainHttpConfig.edge?.enableHttps).toBe(false);
    const plainHttp = { domains: [], enableHttps: false };
    for (const input of [
      { ...sandboxConfigInput, edge: plainHttp },
      { ...sharedInput, stage: "production", edge: plainHttp },
    ]) {
      const rejected = rejection(input);
      expect(rejected?.reason).toBe("edge");
      expect(rejected?.paths).toEqual(["edge.enableHttps"]);
    }
    const { budget: _proofBudget, ...proofShared } = proofInput;
    expect(
      rejection({ ...proofShared, stage: "production", edge: plainHttp })?.paths
    ).toEqual(["edge.enableHttps"]);
  });

  test("requires a hostname while HTTPS is on", () => {
    expect(
      rejection({ ...sandboxConfigInput, edge: { domains: [] } })?.paths
    ).toEqual(["edge.domains"]);
    expect(
      rejection({ ...sandboxConfigInput, edge: { domains: ["Not A Host"] } })
        ?.reason
    ).toBe("schema");
  });

  test("declares no edge on preview, which serves no web service yet", () => {
    expect(
      rejection({ ...sharedInput, stage: "preview", edge: { domains } })
    ).toMatchObject({ reason: "edge", paths: ["edge"] });
  });

  test("routes URL map host patterns only without the managed certificate", () => {
    const patterns = [
      "*",
      "*.example.com",
      "*-preview.example.com",
      "example.com:80",
    ];
    expect(
      decoded({
        ...proofInput,
        edge: { domains: patterns, enableHttps: false },
      }).edge?.domains
    ).toEqual(patterns);
    expect(
      rejection({ ...sandboxConfigInput, edge: { domains: patterns } })
    ).toMatchObject({
      reason: "edge",
      paths: [
        "edge.domains.0",
        "edge.domains.1",
        "edge.domains.2",
        "edge.domains.3",
      ],
    });
    for (const host of ["*example.com", "Workspace.example.com", "a..b"]) {
      expect(
        rejection({
          ...proofInput,
          edge: { domains: [host], enableHttps: false },
        })?.reason
      ).toBe("schema");
    }
  });

  test("takes any positive auth rate limit", () => {
    expect(
      decoded({
        ...sandboxConfigInput,
        edge: { domains, authRateLimitPerMinute: 10_001 },
      }).edge?.authRateLimitPerMinute
    ).toBe(10_001);
    expect(
      rejection({
        ...sandboxConfigInput,
        edge: { domains, authRateLimitPerMinute: 0 },
      })?.reason
    ).toBe("schema");
  });

  test("never takes static paths from configuration", () => {
    expect(
      rejection({
        ...sandboxConfigInput,
        edge: { domains, staticAssetPaths: ["/api/*"] },
      })?.paths
    ).toEqual(["edge.staticAssetPaths"]);
  });

  test("leaves the edge out of a config without one", () => {
    expect(decoded(sandboxConfigInput).edge).toBeUndefined();
  });
});

describe("workspace edge declaration", () => {
  test("declares the HTTPS edge under the existing physical names", async () => {
    const { exit, resources } = await declare(httpsConfig);
    expect(exit._tag).toBe("Success");
    expect(typesOf(resources)).toEqual({
      EdgeAddress: "GCP.Compute.GlobalAddress",
      EdgeWebEndpointGroup: "GCP.Compute.RegionNetworkEndpointGroup",
      EdgeSecurityPolicy: "DeskohubWorkspace.EdgeSecurityPolicy",
      EdgeDynamicBackend: "DeskohubWorkspace.EdgeBackendService",
      EdgeStaticBackend: "DeskohubWorkspace.EdgeBackendService",
      EdgeUrlMap: "GCP.Compute.UrlMap",
      EdgeCertificate: "GCP.Compute.SslCertificate",
      EdgeHttpsProxy: "GCP.Compute.TargetHttpsProxy",
      EdgeHttpsForwardingRule: "GCP.Compute.GlobalForwardingRule",
      EdgeHttpsRedirectUrlMap: "GCP.Compute.UrlMap",
      EdgeHttpsRedirectProxy: "GCP.Compute.TargetHttpProxy",
      EdgeHttpForwardingRule: "GCP.Compute.GlobalForwardingRule",
      EdgeTokenRouteExclusion: "GCP.Logging.Exclusion",
    });
    expect(resources.EdgeAddress?.Props).toEqual({
      addressName: "workspace-sandbox-edge",
    });
    expect(resources.EdgeWebEndpointGroup?.Props).toEqual({
      networkEndpointGroupName: "workspace-sandbox-web",
      region: "europe-west1",
      networkEndpointType: "SERVERLESS",
      cloudRun: { service: "workspace-web" },
    });
    expect(resources.EdgeCertificate?.Props).toEqual({
      sslCertificateName: "workspace-sandbox-edge",
      type: "MANAGED",
      managed: { domains },
    });
    expect(resources.EdgeHttpsProxy?.Props.targetHttpsProxyName).toBe(
      "workspace-sandbox-edge"
    );
    expect(isOutput(resources.EdgeHttpsProxy?.Props.urlMap)).toBe(true);
    expect(resources.EdgeHttpsRedirectUrlMap?.Props).toEqual({
      urlMapName: "workspace-sandbox-https-redirect",
      defaultUrlRedirect: {
        httpsRedirect: true,
        redirectResponseCode: "MOVED_PERMANENTLY_DEFAULT",
        stripQuery: false,
      },
    });
    expect(resources.EdgeHttpsRedirectProxy?.Props.targetHttpProxyName).toBe(
      "workspace-sandbox-https-redirect"
    );
    for (const [id, name, port] of [
      ["EdgeHttpsForwardingRule", "workspace-sandbox-https", "443"],
      ["EdgeHttpForwardingRule", "workspace-sandbox-http", "80"],
    ] as const) {
      const props = resources[id]?.Props;
      expect(props.forwardingRuleName).toBe(name);
      expect(props.loadBalancingScheme).toBe("EXTERNAL_MANAGED");
      expect(props.portRange).toBe(port);
      expect(isOutput(props.ipAddress)).toBe(true);
      expect(isOutput(props.target)).toBe(true);
    }
    expect(resources.EdgeUrlMap?.Props.hostRules).toEqual([
      { hosts: domains, pathMatcher: "workspace" },
    ]);
  });

  test("serves the main URL map over plain HTTP on port 80 without HTTPS", async () => {
    const { exit, resources } = await declare(plainHttpConfig);
    expect(exit._tag).toBe("Success");
    for (const id of [
      "EdgeCertificate",
      "EdgeHttpsProxy",
      "EdgeHttpsForwardingRule",
      "EdgeHttpsRedirectUrlMap",
      "EdgeHttpsRedirectProxy",
    ]) {
      expect(resources[id]).toBeUndefined();
    }
    expect(resources.EdgeHttpProxy?.Props.targetHttpProxyName).toBe(
      "workspace-sandbox-edge-http"
    );
    expect(resources.EdgeHttpForwardingRule?.Props.portRange).toBe("80");
    // Reached by IP address, so any host matches.
    expect(resources.EdgeUrlMap?.Props.hostRules).toEqual([
      { hosts: ["*"], pathMatcher: "workspace" },
    ]);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.edgeProtocol).toBe("http");
    }
  });

  test("routes only the immutable asset paths to the static backend", async () => {
    const { resources } = await declare(httpsConfig);
    const map = resources.EdgeUrlMap?.Props;
    expect(map.urlMapName).toBe("workspace-sandbox-edge");
    expect(map.pathMatchers).toHaveLength(1);
    const [matcher] = map.pathMatchers;
    expect(matcher.name).toBe("workspace");
    expect(matcher.pathRules).toHaveLength(1);
    expect(matcher.pathRules[0].paths).toEqual([
      "/_next/static/*",
      "/app/_expo/static/*",
      "/polyfills/*",
    ]);
    expect(edgeStaticAssetPaths).toEqual(matcher.pathRules[0].paths);
    // Default and matcher default go to dynamic, the path rule to static.
    expect(isOutput(map.defaultService)).toBe(true);
    expect(matcher.defaultService).toBe(map.defaultService);
    expect(matcher.pathRules[0].service).not.toBe(map.defaultService);
  });

  test("keeps CDN off the dynamic backend and opt-in on the static one", async () => {
    for (const staticCdnEnabled of [false, true]) {
      const { resources } = await declare(httpsConfig, { staticCdnEnabled });
      const dynamic = resources.EdgeDynamicBackend?.Props;
      const statics = resources.EdgeStaticBackend?.Props;
      expect(dynamic).toMatchObject({
        project: httpsConfig.projectId,
        name: "workspace-sandbox-dynamic",
        loadBalancingScheme: "EXTERNAL_MANAGED",
        protocol: "HTTPS",
        logConfig: { enable: false },
      });
      expect("cdnPolicy" in dynamic).toBe(false);
      expect(statics).toMatchObject({
        name: "workspace-sandbox-static",
        loadBalancingScheme: "EXTERNAL_MANAGED",
        protocol: "HTTPS",
        logConfig: { enable: true, sampleRate: 1 },
      });
      expect(statics.cdnPolicy).toEqual(
        staticCdnEnabled
          ? {
              cacheMode: "USE_ORIGIN_HEADERS",
              negativeCaching: false,
              cacheKeyPolicy: {
                includeHost: true,
                includeProtocol: true,
                includeQueryString: false,
              },
            }
          : undefined
      );
      // Both backends front the one NEG behind the one Cloud Armor policy.
      for (const props of [dynamic, statics]) {
        expect(isOutput(props.backendGroup)).toBe(true);
        expect(isOutput(props.securityPolicy)).toBe(true);
      }
    }
  });

  test("starts Cloud Armor with WAF in preview, auth throttling and a default allow", async () => {
    const { resources } = await declare(httpsConfig);
    expect(resources.EdgeSecurityPolicy?.Props).toEqual({
      project: httpsConfig.projectId,
      name: "workspace-sandbox-edge",
      description: "Workspace sandbox edge policy",
      type: "CLOUD_ARMOR",
      rules: [
        {
          action: "deny(403)",
          priority: 1000,
          preview: true,
          description: "Preconfigured SQL injection rules",
          match: {
            expr: {
              expression:
                "evaluatePreconfiguredWaf('sqli-v33-stable', {'sensitivity': 1})",
            },
          },
        },
        {
          action: "deny(403)",
          priority: 1010,
          preview: true,
          description: "Preconfigured cross-site scripting rules",
          match: {
            expr: {
              expression:
                "evaluatePreconfiguredWaf('xss-v33-stable', {'sensitivity': 1})",
            },
          },
        },
        {
          action: "throttle",
          priority: 2000,
          description: "Throttle auth endpoints per client IP",
          preview: false,
          match: {
            expr: { expression: "request.path.startsWith('/api/auth/')" },
          },
          rateLimitOptions: {
            conformAction: "allow",
            exceedAction: "deny(429)",
            enforceOnKey: "IP",
            rateLimitThreshold: { count: 120, intervalSec: 60 },
          },
        },
        {
          action: "allow",
          priority: 2147483647,
          description: "Default allow",
          preview: false,
          match: {
            versionedExpr: "SRC_IPS_V1",
            config: { srcIpRanges: ["*"] },
          },
        },
      ],
    });
    const enforced = await declare(httpsConfig, {
      wafPreview: false,
      authRateLimitPerMinute: 60,
    });
    const rules = enforced.resources.EdgeSecurityPolicy?.Props.rules;
    expect(rules[0].preview).toBe(false);
    expect(rules[1].preview).toBe(false);
    expect(rules[2].rateLimitOptions.rateLimitThreshold.count).toBe(60);
  });

  test("points the endpoint group at the declared web service", async () => {
    // Any declared resource's output stands in for the web service name.
    const { exit, resources } = await evaluate(
      Effect.gen(function* () {
        const service = yield* Storage.Bucket("WebServiceStandIn", {});
        return yield* declareWorkspaceEdge(
          httpsConfig,
          edgeOf(httpsConfig),
          service.bucketName
        );
      })
    );
    expect(exit._tag).toBe("Success");
    expect(
      isOutput(resources.EdgeWebEndpointGroup?.Props.cloudRun.service)
    ).toBe(true);
  });

  test("drops request logs for every token-bearing route", async () => {
    expect(tokenRouteExclusionFilter).toBe(
      '(resource.type="http_load_balancer" OR (resource.type="cloud_run_revision" AND log_id("run.googleapis.com/requests"))) AND httpRequest.requestUrl=~"^https?://[^/]+(/app/auth/callback|/api/auth/magic-link/verify|/api/email-campaigns/unsubscribe|(/[a-z]{2,3}-[A-Z]{2})?/marketing-preferences/access)([/?#]|$)"'
    );
    const { resources } = await declare(httpsConfig);
    expect(resources.EdgeTokenRouteExclusion?.Props).toEqual({
      exclusionId: "workspace-sandbox-token-route-requests",
      description: "Raw request logs for token-bearing Workspace routes",
      filter: tokenRouteExclusionFilter,
    });

    const pattern = new RegExp(
      tokenRouteExclusionFilter.match(/requestUrl=~"(.*)"$/)?.[1] ?? "^$"
    );
    for (const url of [
      "https://workspace.example.com/app/auth/callback?code=x",
      "https://workspace.example.com/api/auth/magic-link/verify?token=x",
      "http://203.0.113.10/api/email-campaigns/unsubscribe/x",
      "https://workspace.example.com/marketing-preferences/access#t",
      "https://workspace.example.com/cs-CZ/marketing-preferences/access?t=x",
      "https://workspace.example.com/app/auth/callback",
    ]) {
      expect(url).toMatch(pattern);
    }
    for (const url of [
      "https://workspace.example.com/",
      "https://workspace.example.com/api/auth/session",
      "https://workspace.example.com/app/auth/callbacks",
      "https://workspace.example.com/x/app/auth/callback",
    ]) {
      expect(url).not.toMatch(pattern);
    }

    // Every locale prefix in the Workspace router matches the generic one.
    const vercel = (await Bun.file(
      new URL("../../../apps/deskohub-workspace/vercel.json", import.meta.url)
    ).json()) as { routes: ReadonlyArray<{ src: string }> };
    const locales =
      vercel.routes
        .map((route) => route.src.match(/^\^\/\(\?:([^)]*)\)/)?.[1])
        .find((match) => match?.includes("en-US"))
        ?.split("|") ?? [];
    expect(locales.length).toBeGreaterThan(0);
    for (const locale of locales) {
      expect(
        `https://workspace.example.com/${locale}/marketing-preferences/access`
      ).toMatch(pattern);
    }
  });

  test("returns the outputs the hosted proof reads back", async () => {
    const { exit } = await declare(httpsConfig);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(Object.keys(exit.value).sort()).toEqual([
        "backendServices",
        "edgeIpAddress",
        "edgeProtocol",
        "securityPolicy",
        "tokenRouteExclusionFilter",
      ]);
      expect(exit.value.edgeProtocol).toBe("https");
      expect(Object.keys(exit.value.backendServices).sort()).toEqual([
        "dynamic",
        "static",
      ]);
    }
  });
});
