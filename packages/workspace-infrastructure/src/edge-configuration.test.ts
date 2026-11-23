import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";

/**
 * Static checks of the Terraform edge. CI has no Terraform; these pin the
 * contract `terraform validate` cannot: CDN stays off dynamic routes, both
 * backends carry Cloud Armor, and token-bearing request logs are dropped.
 */
const edgeDirectory = new URL(
  "../../../infra/workspace-edge/",
  import.meta.url
);
const files = readdirSync(edgeDirectory).filter((name) => name.endsWith(".tf"));
const sources = Object.fromEntries(
  await Promise.all(
    files.map(
      async (name) =>
        [name, await Bun.file(new URL(name, edgeDirectory)).text()] as const
    )
  )
);
const all = Object.values(sources).join("\n");

/** The body of one `resource "<type>" "<name>"` block, by brace matching. */
const resourceBlock = (type: string, name: string) => {
  const start = all.indexOf(`resource "${type}" "${name}" {`);
  if (start < 0) {
    return undefined;
  }
  let depth = 0;
  for (let index = all.indexOf("{", start); index < all.length; index++) {
    if (all[index] === "{") {
      depth += 1;
    } else if (all[index] === "}") {
      depth -= 1;
    }
    if (depth === 0) {
      return all.slice(start, index + 1);
    }
  }
  return undefined;
};

describe("workspace edge Terraform", () => {
  test("balances braces in every file", () => {
    for (const [name, source] of Object.entries(sources)) {
      const withoutStrings = source.replace(/"(?:[^"\\]|\\.)*"/g, '""');
      expect({
        name,
        open: withoutStrings.split("{").length,
      }).toEqual({ name, open: withoutStrings.split("}").length });
    }
  });

  test("requires Terraform 1.9 and the google provider with a GCS backend", () => {
    expect(all).toContain('required_version = ">= 1.9"');
    expect(all).toMatch(/source\s+= "hashicorp\/google"/);
    expect(all).toContain('backend "gcs" {}');
    expect(all).toMatch(/variable "region" \{[^}]*default\s+= "europe-west1"/);
  });

  test("fronts the Cloud Run web service through a serverless NEG", () => {
    const neg = resourceBlock(
      "google_compute_region_network_endpoint_group",
      "web"
    );
    expect(neg).toContain('network_endpoint_type = "SERVERLESS"');
    expect(neg).toContain("service = var.web_service_name");
    expect(all).toMatch(
      /variable "web_service_name" \{[^}]*default\s+= "workspace-web"/
    );
    expect(
      resourceBlock("google_compute_global_forwarding_rule", "https")
    ).toContain('port_range            = "443"');
    expect(resourceBlock("google_compute_url_map", "https_redirect")).toContain(
      "https_redirect         = true"
    );
  });

  test("keeps CDN off dynamic routes and opt-in for static assets", () => {
    const dynamic = resourceBlock("google_compute_backend_service", "dynamic");
    const staticAssets = resourceBlock(
      "google_compute_backend_service",
      "static"
    );
    expect(dynamic).toContain("enable_cdn            = false");
    expect(dynamic).not.toContain("cdn_policy");
    expect(staticAssets).toContain(
      "enable_cdn            = var.static_cdn_enabled"
    );
    expect(all).toMatch(
      /variable "static_cdn_enabled" \{[^}]*default\s+= false/
    );
    // Overrides may only name immutable build-asset paths.
    expect(sources["variables.tf"]).toContain(
      'contains(["/_next/static/*", "/app/_expo/static/*", "/polyfills/*"], path)'
    );
    for (const block of [dynamic, staticAssets]) {
      expect(block).toContain(
        "security_policy       = google_compute_security_policy.workspace.id"
      );
    }
    const urlMap = resourceBlock("google_compute_url_map", "workspace");
    expect(urlMap).toContain(
      "default_service = google_compute_backend_service.dynamic.id"
    );
  });

  test("starts Cloud Armor with WAF, auth throttling and a default rule", () => {
    const policy = resourceBlock("google_compute_security_policy", "workspace");
    expect(policy).toContain("sqli-v33-stable");
    expect(policy).toContain("xss-v33-stable");
    expect(policy).toContain("request.path.startsWith('/api/auth/')");
    expect(policy).toContain('exceed_action  = "deny(429)"');
    expect(policy).toContain("priority    = 2147483647");
  });

  test("drops request logs for every token-bearing route", async () => {
    const exclusion = resourceBlock(
      "google_logging_project_exclusion",
      "token_route_requests"
    );
    expect(exclusion).toBeDefined();
    for (const route of [
      '"/app/auth/callback"',
      '"/api/auth/magic-link/verify"',
      "/marketing-preferences/access",
      'resource.type=\\"http_load_balancer\\"',
      'log_id(\\"run.googleapis.com/requests\\")',
    ]) {
      expect(all).toContain(route);
    }
    expect(all).toContain('"/api/email-campaigns/unsubscribe"');
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
      expect(`/${locale}`).toMatch(/^\/[a-z]{2,3}-[A-Z]{2}$/);
    }
    expect(all).toContain('locale_prefix = "(/[a-z]{2,3}-[A-Z]{2})?"');
  });

  test("serves HTTPS with a managed certificate and redirect by default", () => {
    expect(all).toMatch(
      /variable "enable_https" \{[^}]*type\s+= bool\s+default\s+= true/
    );
    for (const [type, name] of [
      ["google_compute_managed_ssl_certificate", "workspace"],
      ["google_compute_target_https_proxy", "workspace"],
      ["google_compute_global_forwarding_rule", "https"],
      ["google_compute_url_map", "https_redirect"],
      ["google_compute_target_http_proxy", "https_redirect"],
    ] as const) {
      expect(resourceBlock(type, name)).toMatch(
        /count\s+= var\.enable_https \? 1 : 0/
      );
      // Existing HTTPS state moves to index 0 instead of being replaced.
      expect(all).toContain(
        `moved {\n  from = ${type}.${name}\n  to   = ${type}.${name}[0]\n}`
      );
    }
    expect(
      resourceBlock("google_compute_target_https_proxy", "workspace")
    ).toContain(
      "ssl_certificates = [google_compute_managed_ssl_certificate.workspace[0].id]"
    );
    expect(
      resourceBlock("google_compute_global_forwarding_rule", "http")
    ).toContain("? google_compute_target_http_proxy.https_redirect[0].id");
  });

  test("serves the main URL map over plain HTTP when HTTPS is disabled", () => {
    const proxy = resourceBlock(
      "google_compute_target_http_proxy",
      "workspace"
    );
    expect(proxy).toContain("count   = var.enable_https ? 0 : 1");
    expect(proxy).toContain("url_map = google_compute_url_map.workspace.id");
    const http = resourceBlock("google_compute_global_forwarding_rule", "http");
    expect(http).not.toContain("count");
    expect(http).toContain('port_range            = "80"');
    expect(http).toContain(
      ": google_compute_target_http_proxy.workspace[0].id"
    );
    // Without domains the URL map still routes static paths, for any host.
    expect(resourceBlock("google_compute_url_map", "workspace")).toContain(
      'hosts        = length(var.domains) > 0 ? var.domains : ["*"]'
    );
  });

  test("allows plain HTTP only in the sandbox", () => {
    expect(sources["variables.tf"]).toContain(
      'condition     = var.enable_https || var.stage == "sandbox"'
    );
  });

  test("requires domains while HTTPS is enabled", () => {
    expect(sources["variables.tf"]).toContain(
      "condition     = length(var.domains) > 0 || !var.enable_https"
    );
  });

  test("reports the edge protocol beside the existing outputs", () => {
    const outputs = sources["outputs.tf"] ?? "";
    expect(outputs).toContain(
      'value       = var.enable_https ? "https" : "http"'
    );
    for (const name of [
      "edge_protocol",
      "edge_ip_address",
      "security_policy",
      "backend_services",
    ]) {
      expect(outputs).toContain(`output "${name}" {`);
    }
    // Outputs never read a resource that may have count 0.
    expect(outputs).not.toMatch(/\[0\]/);
    for (const name of [
      "google_compute_managed_ssl_certificate",
      "google_compute_target_https_proxy",
      "google_compute_url_map.https_redirect",
      "google_compute_target_http_proxy",
      "google_compute_global_forwarding_rule",
    ]) {
      expect(outputs).not.toContain(name);
    }
  });

  test("keeps request logging off on the dynamic backend", () => {
    expect(resourceBlock("google_compute_backend_service", "dynamic")).toMatch(
      /log_config \{\s*enable = false\s*\}/
    );
  });
});
