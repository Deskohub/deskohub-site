import { describe, expect, test } from "bun:test";
import { type Attributes, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { isAllowedSpanName, sanitizeSpanText } from "./span-allowlist";
import { createWorkspaceOTelRegistration } from "./telemetry-sinks";

// Synthetic markers only: each stands for a credential or personal value a
// span must never export. The control marker sits in an allowlisted field,
// so finding it proves the span arrived.
const tokenMarker = "tokSynthMarker7Q2xK9vB4nR8mW1zL6pD3";
const addressMarker = "synthetic-marker-recipient@deskohub.invalid";
const pathMarker = "accessSynthMarker5H8kT2qW9xY4";
const controlRoute = "/[locale]/control-marker-route";

const leakingMarkers = [
  tokenMarker,
  encodeURIComponent(tokenMarker),
  addressMarker,
  encodeURIComponent(addressMarker),
  pathMarker,
];

/** Records a representative set of unsafe spans through `provider`. */
const recordUnsafeSpans = (provider: BasicTracerProvider) => {
  const tracer = provider.getTracer("span-allowlist-test");
  const record = (
    name: string,
    attributes: Attributes,
    finish?: (span: ReturnType<typeof tracer.startSpan>) => void
  ) => {
    const span = tracer.startSpan(name, { attributes, kind: SpanKind.SERVER });
    finish?.(span);
    span.end();
  };

  record(
    `GET https://workspace.invalid/api/auth/magic-link/verify?token=${tokenMarker}`,
    {
      "http.request.method": "GET",
      "http.route": "/api/auth/magic-link/verify",
      "http.response.status_code": 302,
      "url.full": `https://workspace.invalid/api/auth/magic-link/verify?token=${tokenMarker}`,
      "url.path": "/api/auth/magic-link/verify",
      "url.query": `token=${tokenMarker}`,
      "http.target": `/api/auth/magic-link/verify?token=${tokenMarker}`,
      "http.request.header.authorization": [`Bearer ${tokenMarker}`],
      "http.request.header.cookie": [`session=${tokenMarker}`],
      "user_agent.original": addressMarker,
      "client.address": "198.51.100.7",
    }
  );
  record(`GET /cs-CZ/marketing-preferences/access/${pathMarker}`, {
    "http.method": "GET",
  });
  record(`send magic link to ${addressMarker}`, {});
  record(`account.lookup ${pathMarker}`, {});
  record(
    "checkout.createHostedPaymentCheckout",
    {
      callbackUrl: `https://workspace.invalid/app/auth/callback?code=${tokenMarker}`,
      returnPath: `/cs-CZ/marketing-preferences/access/${pathMarker}`,
      "http.route": controlRoute,
    },
    (span) => {
      span.addEvent("exception", {
        "exception.type": "ProviderError",
        "exception.message": `provider said ${tokenMarker} for ${addressMarker}`,
        "exception.stacktrace": `Error: ${tokenMarker}\n    at provider`,
      });
      span.addEvent(`retry ${addressMarker}`);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: `failed for ${addressMarker}`,
      });
    }
  );
  record("sql.execute", {
    "db.system.name": "postgresql",
    "db.query.text": `select * from verification where token = '${tokenMarker}'`,
  });
  record("http.client GET", {
    "http.request.method": "GET",
    "server.address": "api.provider.invalid",
    "url.full": `https://api.provider.invalid/v1/customers?email=${addressMarker}`,
  });
};

const exportedFields = (spans: readonly ReadableSpan[]) =>
  JSON.stringify(
    spans.map(({ name, attributes, events, status, links }) => ({
      name,
      attributes,
      events,
      status,
      links,
    }))
  );

/** The registration's processors, with an exporter for the automatic slot. */
const registrationProvider = (exporter: SpanExporter) =>
  new BasicTracerProvider({
    spanProcessors: createWorkspaceOTelRegistration().spanProcessors.map(
      (processor): SpanProcessor =>
        processor === "auto" ? new SimpleSpanProcessor(exporter) : processor
    ),
  });

describe("Workspace span allowlist", () => {
  test("exports no token, address or token-bearing path from names, attributes, events or status", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = registrationProvider(exporter);

    try {
      recordUnsafeSpans(provider);
      await provider.forceFlush();

      const spans = exporter.getFinishedSpans();
      const exported = exportedFields(spans);
      expect(spans).toHaveLength(7);
      for (const marker of leakingMarkers) {
        expect(exported).not.toContain(marker);
      }
      expect(exported).toContain(controlRoute);
    } finally {
      await provider.shutdown();
    }
  });

  test("keeps route templates, status codes, stable names and provider hosts", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = registrationProvider(exporter);

    try {
      recordUnsafeSpans(provider);
      await provider.forceFlush();

      const spans = exporter.getFinishedSpans();
      const [verify, accessPage, addressed, lookup, checkout, sql, client] =
        spans;
      expect(verify?.name).toBe("GET /api/auth/magic-link/verify");
      expect(verify?.attributes).toEqual({
        "http.request.method": "GET",
        "http.route": "/api/auth/magic-link/verify",
        "http.response.status_code": 302,
      });
      expect(accessPage?.name).toBe("GET");
      expect(addressed?.name).toBe("span");
      expect(lookup?.name).toBe("span");
      expect(checkout?.name).toBe("checkout.createHostedPaymentCheckout");
      expect(checkout?.status.code).toBe(SpanStatusCode.ERROR);
      expect(checkout?.status.message).toBeUndefined();
      expect(checkout?.events.map(({ name }) => name)).toEqual([
        "exception",
        "event",
      ]);
      expect(checkout?.events[0]?.attributes).toEqual({
        "exception.type": "ProviderError",
      });
      expect(checkout?.attributes.callbackUrl).toBe(
        "https://workspace.invalid"
      );
      expect(sql?.attributes["db.query.text"]).toBe(
        "select * from verification where token = '?'"
      );
      expect(client?.name).toBe("http.client GET");
      expect(client?.attributes["server.address"]).toBe("api.provider.invalid");
    } finally {
      await provider.shutdown();
    }
  });

  test("sends only allowlisted, censored spans to a loopback OTLP collector", async () => {
    const bodies: Uint8Array[] = [];
    const collector = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        bodies.push(new Uint8Array(await request.arrayBuffer()));
        return new Response(null, { status: 200 });
      },
    });
    const registration = createWorkspaceOTelRegistration({
      otlpEndpoint: `http://127.0.0.1:${collector.port}`,
    });
    if (!registration.traceExporter) {
      throw new Error("An OTLP endpoint must configure the trace exporter.");
    }
    // `registerOTel` puts the configured exporter after every processor.
    const provider = new BasicTracerProvider({
      spanProcessors: [
        ...registration.spanProcessors.filter(
          (processor): processor is Exclude<typeof processor, "auto"> =>
            processor !== "auto"
        ),
        new BatchSpanProcessor(registration.traceExporter),
      ],
    });

    try {
      recordUnsafeSpans(provider);
      await provider.forceFlush();

      const received = new TextDecoder().decode(
        Buffer.concat(bodies.map((body) => Buffer.from(body)))
      );
      expect(bodies.length).toBeGreaterThan(0);
      expect(received).toContain(controlRoute);
      for (const marker of leakingMarkers) {
        expect(received).not.toContain(marker);
      }
    } finally {
      await provider.shutdown();
      await collector.stop(true);
    }
  });
});

describe("isAllowedSpanName", () => {
  test("accepts stable operation names and route templates", () => {
    for (const name of [
      "checkout.createHostedPaymentCheckout",
      "http.client GET",
      "GET /[locale]/account",
      "render route (app) /[locale]/reservation/[reservationId]",
      "executing api route (app) /api/auth/[...all]/route",
      "resolve page components",
    ]) {
      expect(isAllowedSpanName(name)).toBe(true);
    }
  });

  test("rejects URLs, query strings, addresses, encoded values and identifiers", () => {
    for (const name of [
      "GET https://workspace.invalid/",
      "GET /api/auth/magic-link/verify?token=abc",
      `send to ${addressMarker}`,
      "GET /access/abc%20def",
      `GET /cs-CZ/marketing-preferences/access/${pathMarker}`,
      "reservation 4f1c2a9e-0b7d-4a51-9a3e-2d4b6c8e1f00",
      "order 1234567890",
      "",
    ]) {
      expect(isAllowedSpanName(name)).toBe(false);
    }
  });
});

describe("sanitizeSpanText", () => {
  test("keeps the origin of a URL and the template of a path", () => {
    expect(
      sanitizeSpanText(
        `redirect to https://workspace.invalid/app/auth/callback?code=${tokenMarker}#done`
      )
    ).toBe("redirect to https://workspace.invalid");
    expect(
      sanitizeSpanText(`/cs-CZ/marketing-preferences/access/${pathMarker}?x=1`)
    ).toBe("/cs-CZ/marketing-preferences/access/:redacted");
  });

  test("removes long token-shaped runs from free text", () => {
    expect(sanitizeSpanText(`session ${tokenMarker} expired`)).toBe(
      "session [redacted] expired"
    );
  });
});
