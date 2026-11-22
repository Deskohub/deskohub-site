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
    const locales = (await Bun.file(
      new URL("../../../apps/deskohub-workspace/vercel.json", import.meta.url)
    ).json()) as { routes: ReadonlyArray<{ src: string }> };
    const localized = locales.routes
      .map((route) => route.src.match(/^\^\/\(\?:([^)]*)\)/)?.[1])
      .find((match) => match?.includes("en-US"));
    expect(all).toContain(
      `workspace_locales = [${(localized ?? "")
        .split("|")
        .map((locale) => `"${locale}"`)
        .join(", ")}]`
    );
  });
});
