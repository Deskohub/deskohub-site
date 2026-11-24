import * as Compute from "@alchemy.run/gcp/Compute";
import * as Logging from "@alchemy.run/gcp/Logging";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import type {
  WorkspaceEdgeConfig,
  WorkspaceStackConfig,
} from "../config/stack-config";
import { EdgeBackendService } from "./edge-backend-service";
import {
  EdgeSecurityPolicy,
  type EdgeSecurityPolicyProps,
} from "./edge-security-policy";

/**
 * The immutable build-asset paths, the only routes the static backend and
 * its optional Cloud CDN serve. Fixed here, never configured.
 */
export const edgeStaticAssetPaths = [
  "/_next/static/*",
  "/app/_expo/static/*",
  "/polyfills/*",
] as const;

/** The physical name of one edge object, unchanged from the Terraform edge. */
export const edgeResourceName = (
  config: WorkspaceStackConfig,
  suffix: string
) => `workspace-${config.stage}-${suffix}`;

/**
 * The physical names of the plain-HTTP edge's objects: what the stack
 * declares and what a live readback, such as the hosted proof's, looks up.
 */
export const edgeObjectNames = (config: WorkspaceStackConfig) => ({
  address: edgeResourceName(config, "edge"),
  endpointGroup: edgeResourceName(config, "web"),
  securityPolicy: edgeResourceName(config, "edge"),
  dynamicBackend: edgeResourceName(config, "dynamic"),
  staticBackend: edgeResourceName(config, "static"),
  urlMap: edgeResourceName(config, "edge"),
  httpProxy: edgeResourceName(config, "edge-http"),
  httpForwardingRule: edgeResourceName(config, "http"),
  tokenRouteExclusion: edgeResourceName(config, "token-route-requests"),
});

/** Any BCP 47 locale prefix the router may add before a route. */
const localePrefix = "(/[a-z]{2,3}-[A-Z]{2})?";

/** Routes whose URLs carry one-time tokens. */
export const tokenRoutePatterns = [
  "/app/auth/callback",
  "/api/auth/magic-link/verify",
  "/api/email-campaigns/unsubscribe",
  `${localePrefix}/marketing-preferences/access`,
] as const;

/** Load balancer and Cloud Run request logs both record the full URL. */
const requestLogSources =
  '(resource.type="http_load_balancer" OR (resource.type="cloud_run_revision" AND log_id("run.googleapis.com/requests")))';

/**
 * The project exclusion filter that drops raw request logs of the token
 * routes. It applies to the `_Default` sink only; the hosted proof checks
 * every other sink applies the same filter.
 */
export const tokenRouteExclusionFilter = [
  requestLogSources,
  `httpRequest.requestUrl=~"^https?://[^/]+(${tokenRoutePatterns.join("|")})([/?#]|$)"`,
].join(" AND ");

export const edgeSecurityPolicyProps = (
  config: WorkspaceStackConfig,
  edge: WorkspaceEdgeConfig
): EdgeSecurityPolicyProps => ({
  project: config.projectId,
  name: edgeObjectNames(config).securityPolicy,
  description: `Workspace ${config.stage} edge policy`,
  type: "CLOUD_ARMOR",
  rules: [
    {
      action: "deny(403)",
      priority: 1000,
      preview: edge.wafPreview,
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
      preview: edge.wafPreview,
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
      match: { expr: { expression: "request.path.startsWith('/api/auth/')" } },
      rateLimitOptions: {
        conformAction: "allow",
        exceedAction: "deny(429)",
        enforceOnKey: "IP",
        rateLimitThreshold: {
          count: edge.authRateLimitPerMinute,
          intervalSec: 60,
        },
      },
    },
    {
      action: "allow",
      priority: 2147483647,
      description: "Default allow",
      preview: false,
      match: { versionedExpr: "SRC_IPS_V1", config: { srcIpRanges: ["*"] } },
    },
  ],
});

/** Links the backends take from the objects declared before them. */
export interface EdgeBackendLinks {
  readonly backendGroup: Input<string>;
  readonly securityPolicy: Input<string>;
}

/**
 * Dynamic pages, Server Actions, auth and API routes: never cached, and
 * request logging off so token URLs never reach the load balancer log.
 */
export const edgeDynamicBackendProps = (
  config: WorkspaceStackConfig,
  links: EdgeBackendLinks
) => ({
  project: config.projectId,
  name: edgeObjectNames(config).dynamicBackend,
  loadBalancingScheme: "EXTERNAL_MANAGED" as const,
  protocol: "HTTPS" as const,
  ...links,
  logConfig: { enable: false },
});

/** Immutable build assets; Cloud CDN is opt-in and honours origin headers. */
export const edgeStaticBackendProps = (
  config: WorkspaceStackConfig,
  edge: WorkspaceEdgeConfig,
  links: EdgeBackendLinks
) => {
  const props = {
    project: config.projectId,
    name: edgeObjectNames(config).staticBackend,
    loadBalancingScheme: "EXTERNAL_MANAGED" as const,
    protocol: "HTTPS" as const,
    ...links,
    logConfig: { enable: true, sampleRate: 1 },
  };
  return edge.staticCdnEnabled
    ? {
        ...props,
        cdnPolicy: {
          cacheMode: "USE_ORIGIN_HEADERS" as const,
          negativeCaching: false,
          cacheKeyPolicy: {
            includeHost: true,
            includeProtocol: true,
            includeQueryString: false,
          },
        },
      }
    : props;
};

/**
 * The main URL map: everything to the dynamic backend except the static
 * asset paths. Without HTTPS the proof reaches the edge by IP address, so
 * any host matches.
 */
export const edgeUrlMapProps = (
  config: WorkspaceStackConfig,
  edge: WorkspaceEdgeConfig,
  backends: { readonly dynamic: Input<string>; readonly static: Input<string> }
) => ({
  urlMapName: edgeObjectNames(config).urlMap,
  defaultService: backends.dynamic,
  hostRules: [
    {
      hosts: edge.domains.length > 0 ? [...edge.domains] : ["*"],
      pathMatcher: "workspace",
    },
  ],
  pathMatchers: [
    {
      name: "workspace",
      defaultService: backends.dynamic,
      pathRules: [
        { paths: [...edgeStaticAssetPaths], service: backends.static },
      ],
    },
  ],
});

export const edgeHttpsRedirectUrlMapProps = (
  config: WorkspaceStackConfig
): Compute.UrlMapProps => ({
  urlMapName: edgeResourceName(config, "https-redirect"),
  defaultUrlRedirect: {
    httpsRedirect: true,
    redirectResponseCode: "MOVED_PERMANENTLY_DEFAULT",
    stripQuery: false,
  },
});

/** Every created Compute object reports its self link. */
const declaredLink = (resource: string) =>
  Output.map((link: string | undefined) => {
    if (link === undefined) {
      throw new Error(`${resource} reported no self link`);
    }
    return link;
  });

/**
 * The stage's edge: an external Application Load Balancer in front of the
 * web service with Cloud Armor, opt-in Cloud CDN on static assets and a
 * project exclusion for token-route request logs. The serverless NEG names
 * the declared web service's ID output, so it is created after the service
 * and destroyed before it.
 *
 * By default port 443 serves HTTPS with a managed certificate and port 80
 * only redirects. A sandbox proof without DNS turns HTTPS off: port 80 then
 * serves the main URL map over plain HTTP and no certificate exists.
 */
export const declareWorkspaceEdge = Effect.fn(
  "WorkspaceStack.declareWorkspaceEdge"
)(function* (
  config: WorkspaceStackConfig,
  edge: WorkspaceEdgeConfig,
  /** The declared web service's ID (not its full resource name). */
  webServiceId: Input<string>
) {
  const address = yield* Compute.GlobalAddress("EdgeAddress", {
    addressName: edgeObjectNames(config).address,
  });
  const addressLink = address.selfLink.pipe(declaredLink("EdgeAddress"));
  const endpointGroup = yield* Compute.RegionNetworkEndpointGroup(
    "EdgeWebEndpointGroup",
    {
      networkEndpointGroupName: edgeObjectNames(config).endpointGroup,
      region: config.region,
      networkEndpointType: "SERVERLESS",
      cloudRun: { service: webServiceId },
    }
  );
  const policy = yield* EdgeSecurityPolicy(
    "EdgeSecurityPolicy",
    edgeSecurityPolicyProps(config, edge)
  );
  const links = {
    backendGroup: endpointGroup.selfLink.pipe(
      declaredLink("EdgeWebEndpointGroup")
    ),
    securityPolicy: policy.selfLink,
  };
  const dynamicBackend = yield* EdgeBackendService(
    "EdgeDynamicBackend",
    edgeDynamicBackendProps(config, links)
  );
  const staticBackend = yield* EdgeBackendService(
    "EdgeStaticBackend",
    edgeStaticBackendProps(config, edge, links)
  );
  const urlMap = yield* Compute.UrlMap(
    "EdgeUrlMap",
    edgeUrlMapProps(config, edge, {
      dynamic: dynamicBackend.selfLink,
      static: staticBackend.selfLink,
    })
  );
  const urlMapLink = urlMap.selfLink.pipe(declaredLink("EdgeUrlMap"));

  let httpTarget: Input<string>;
  if (edge.enableHttps) {
    const certificate = yield* Compute.SslCertificate("EdgeCertificate", {
      sslCertificateName: edgeResourceName(config, "edge"),
      type: "MANAGED",
      managed: { domains: [...edge.domains] },
    });
    const httpsProxy = yield* Compute.TargetHttpsProxy("EdgeHttpsProxy", {
      targetHttpsProxyName: edgeResourceName(config, "edge"),
      urlMap: urlMapLink,
      sslCertificates: [
        certificate.selfLink.pipe(declaredLink("EdgeCertificate")),
      ],
    });
    yield* Compute.GlobalForwardingRule("EdgeHttpsForwardingRule", {
      forwardingRuleName: edgeResourceName(config, "https"),
      loadBalancingScheme: "EXTERNAL_MANAGED" as const,
      ipAddress: addressLink,
      portRange: "443",
      target: httpsProxy.selfLink.pipe(declaredLink("EdgeHttpsProxy")),
    });
    const redirectMap = yield* Compute.UrlMap(
      "EdgeHttpsRedirectUrlMap",
      edgeHttpsRedirectUrlMapProps(config)
    );
    const redirectProxy = yield* Compute.TargetHttpProxy(
      "EdgeHttpsRedirectProxy",
      {
        targetHttpProxyName: edgeResourceName(config, "https-redirect"),
        urlMap: redirectMap.selfLink.pipe(
          declaredLink("EdgeHttpsRedirectUrlMap")
        ),
      }
    );
    httpTarget = redirectProxy.selfLink.pipe(
      declaredLink("EdgeHttpsRedirectProxy")
    );
  } else {
    const httpProxy = yield* Compute.TargetHttpProxy("EdgeHttpProxy", {
      targetHttpProxyName: edgeObjectNames(config).httpProxy,
      urlMap: urlMapLink,
    });
    httpTarget = httpProxy.selfLink.pipe(declaredLink("EdgeHttpProxy"));
  }
  yield* Compute.GlobalForwardingRule("EdgeHttpForwardingRule", {
    forwardingRuleName: edgeObjectNames(config).httpForwardingRule,
    loadBalancingScheme: "EXTERNAL_MANAGED" as const,
    ipAddress: addressLink,
    portRange: "80",
    target: httpTarget,
  });

  const exclusion = yield* Logging.Exclusion("EdgeTokenRouteExclusion", {
    exclusionId: edgeObjectNames(config).tokenRouteExclusion,
    description: "Raw request logs for token-bearing Workspace routes",
    filter: tokenRouteExclusionFilter,
  });

  return {
    edgeIpAddress: address.address,
    edgeProtocol: edge.enableHttps ? ("https" as const) : ("http" as const),
    securityPolicy: policy.name,
    backendServices: {
      dynamic: dynamicBackend.name,
      static: staticBackend.name,
    },
    tokenRouteExclusionFilter: exclusion.filter,
  };
});
