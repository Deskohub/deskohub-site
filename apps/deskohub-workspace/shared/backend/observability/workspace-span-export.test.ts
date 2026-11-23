import { describe, expect, test } from "bun:test";
import { trace } from "@opentelemetry/api";
import { registerOTel } from "@vercel/otel";
import { createWorkspaceOTelRegistration } from "./telemetry-sinks";
import { flushWorkspaceTraces } from "./workspace-telemetry";

// Synthetic markers only; nothing leaves the test's loopback collector.
const tokenMarker = "tokSynthMarker7Q2xK9vB4nR8mW1zL6pD3";
const addressMarker = "synthetic-marker-recipient@deskohub.invalid";

interface ExportedAttribute {
  readonly key: string;
  readonly value: Readonly<Record<string, string | number | boolean>>;
}

interface ExportedSpan {
  readonly name: string;
  readonly attributes: readonly ExportedAttribute[];
}

interface ExportedTraces {
  readonly resourceSpans: readonly {
    readonly resource: { readonly attributes: readonly ExportedAttribute[] };
    readonly scopeSpans: readonly { readonly spans: readonly ExportedSpan[] }[];
  }[];
}

const attributeMap = (attributes: readonly ExportedAttribute[]) =>
  Object.fromEntries(
    attributes.map(({ key, value }) => [key, Object.values(value)[0]])
  );

describe("the container's span export through registerOTel", () => {
  test("sends the collector allowlisted spans only, after every processor ran", async () => {
    const bodies: string[] = [];
    const collector = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        bodies.push(await request.text());
        return new Response(null, { status: 200 });
      },
    });

    try {
      registerOTel(
        createWorkspaceOTelRegistration({
          serviceVersion: "synthetic-sha",
          deploymentId: "synthetic-deployment",
          otlpEndpoint: `http://127.0.0.1:${collector.port}`,
        })
      );
      const span = trace
        .getTracer("workspace-span-export-test")
        .startSpan(
          `fetch GET https://api.provider.invalid/v1/customers?email=${addressMarker}`,
          {
            attributes: {
              "http.method": "GET",
              "http.url": `https://api.provider.invalid/v1/customers?token=${tokenMarker}`,
              "net.peer.name": "api.provider.invalid",
              "db.query.text": `select '${tokenMarker}'`,
              unitId: tokenMarker,
            },
          }
        );
      span.end();
      await flushWorkspaceTraces();

      const exported = bodies.join("\n");
      expect(exported).not.toContain(tokenMarker);
      expect(exported).not.toContain(addressMarker);
      const [resourceSpans] = (JSON.parse(bodies[0] ?? "{}") as ExportedTraces)
        .resourceSpans;
      const [exportedSpan] = resourceSpans?.scopeSpans[0]?.spans ?? [];
      expect(exportedSpan?.name).toBe("GET api.provider.invalid");
      expect(attributeMap(exportedSpan?.attributes ?? [])).toEqual({
        "http.method": "GET",
        "net.peer.name": "api.provider.invalid",
        "operation.name": expect.any(String),
      });
      expect(
        attributeMap(resourceSpans?.resource.attributes ?? [])
      ).toMatchObject({
        "service.name": "deskohub-workspace",
        "service.version": "synthetic-sha",
        "deployment.id": "synthetic-deployment",
      });
    } finally {
      await collector.stop(true);
    }
  });
});
