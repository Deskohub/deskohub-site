import { describe, expect, test } from "bun:test";
import {
  context,
  createTraceState,
  ProxyTracerProvider,
  propagation,
  SpanKind,
  TraceFlags,
  trace,
} from "@opentelemetry/api";
import { registerOTel } from "@vercel/otel";
import { Predicate } from "effect";
import { createWorkspaceOTelRegistration } from "./telemetry-sinks";
import { flushWorkspaceTraces } from "./workspace-telemetry";

// Synthetic markers only; nothing leaves the test's loopback collector.
const traceStateMarker = "statemarker";
const tokenMarker = "tokSynthMarker7Q2xK9vB4nR8mW1zL6pD3";
const addressMarker = "synthetic-marker-recipient@deskohub.invalid";

interface ExportedAttribute {
  readonly key: string;
  readonly value: Readonly<Record<string, string | number | boolean>>;
}

interface ExportedSpan {
  readonly name: string;
  readonly attributes: readonly ExportedAttribute[];
  readonly parentSpanId?: string;
  readonly links?: readonly { readonly spanId: string }[];
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
      registerOTel({
        ...createWorkspaceOTelRegistration({
          serviceVersion: "synthetic-sha",
          deploymentId: "synthetic-deployment",
          otlpEndpoint: `http://127.0.0.1:${collector.port}`,
        }),
        // The spans are recorded by hand; no instrumentation patches fetch.
        instrumentations: [],
      });
      // A caller's trace context, with trace state from its `tracestate`.
      const callerContext = {
        traceId: "0af7651916cd43dd8448eb211c80319c",
        spanId: "b7ad6b7169203331",
        traceFlags: TraceFlags.SAMPLED,
        traceState: createTraceState(`vendor=${traceStateMarker}`),
      };
      // A server span, which @vercel/otel names a resource for as it ends,
      // under the caller's context and linked to it.
      trace
        .getTracer("workspace-span-export-test")
        .startSpan(
          "GET /api/customers/sample-slug",
          {
            kind: SpanKind.SERVER,
            attributes: {
              "http.method": "GET",
              "http.route": "/api/customers/[customerId]",
              "http.target": "/api/customers/sample-slug",
            },
            links: [{ context: callerContext }],
          },
          trace.setSpanContext(context.active(), callerContext)
        )
        .end();
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
      expect(exported).not.toContain("sample-slug");
      expect(exported).not.toContain(traceStateMarker);
      expect(exported).toContain("0af7651916cd43dd8448eb211c80319c");
      const allResourceSpans = bodies.flatMap(
        (body) => (JSON.parse(body) as ExportedTraces).resourceSpans
      );
      const [resourceSpans] = allResourceSpans;
      const spans = allResourceSpans.flatMap(({ scopeSpans }) =>
        scopeSpans.flatMap(({ spans }) => spans)
      );
      const serverSpan = spans?.find(({ name }) => name.startsWith("GET /"));
      expect(serverSpan?.name).toBe("GET /api/customers/[customerId]");
      // The caller's context survives as the parent and the link.
      expect(serverSpan?.parentSpanId).toBe(callerContext.spanId);
      expect(serverSpan?.links?.map(({ spanId }) => spanId)).toEqual([
        callerContext.spanId,
      ]);
      expect(
        Object.keys(attributeMap(serverSpan?.attributes ?? []))
      ).not.toContain("resource.name");
      const exportedSpan = spans?.find(({ name }) =>
        name.includes("api.provider.invalid")
      );
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
      const registered = trace.getTracerProvider();
      const provider =
        registered instanceof ProxyTracerProvider
          ? registered.getDelegate()
          : registered;
      if (
        Predicate.hasProperty(provider, "shutdown") &&
        Predicate.isFunction(provider.shutdown)
      ) {
        await provider.shutdown();
      }
      trace.disable();
      context.disable();
      propagation.disable();
      await collector.stop(true);
    }
  });
});
