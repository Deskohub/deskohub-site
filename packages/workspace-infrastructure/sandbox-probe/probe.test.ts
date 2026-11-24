import { afterEach, describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import {
  createProbeServer,
  maxTraceAttempts,
  sensitiveRoutes,
} from "./probe.mjs";

/** A structured line the probe logs: an OTLP export attempt or a served request. */
type LogEntry =
  | {
      readonly severity: string;
      readonly message: string;
      readonly otlp: {
        readonly traceId: string;
        readonly status?: number;
        readonly error?: string;
      };
    }
  | {
      readonly severity: string;
      readonly message: string;
      readonly httpRequest: {
        readonly requestMethod: string;
        readonly requestUrl: string;
        readonly status: number;
        readonly latency: string;
      };
      readonly probeVersion: string;
    };

/** The TCP address a listening probe reports. */
const decodeTcpAddress = Schema.decodeUnknownSync(
  Schema.Struct({ port: Schema.Number })
);

const marker = "synthetic-probe-marker";
const servers: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
});

const fakeFetch = (
  handler: (
    ...args: Parameters<typeof globalThis.fetch>
  ) => ReturnType<typeof globalThis.fetch>
): typeof globalThis.fetch =>
  Object.assign(handler, { preconnect: globalThis.fetch.preconnect });

const startProbe = async (fetchImpl: typeof fetch) => {
  const logs: LogEntry[] = [];
  const probe = createProbeServer({
    version: "v2",
    otlpEndpoint: "http://127.0.0.1:4318/",
    otlpTimeoutMs: 200,
    log: (entry: LogEntry) => logs.push(entry),
    fetchImpl,
  });
  await new Promise<void>((resolve) =>
    probe.server.listen(0, "127.0.0.1", resolve)
  );
  servers.push(probe.server);
  const { port } = decodeTcpAddress(probe.server.address());
  return { ...probe, logs, origin: `http://127.0.0.1:${port}` };
};

const collectorAnswering = (status: number) => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = fakeFetch(async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status });
  });
  return { calls, fetchImpl };
};

describe("sandbox probe", () => {
  test("reports its build version on the health route", async () => {
    const { fetchImpl } = collectorAnswering(200);
    const probe = await startProbe(fetchImpl);
    await probe.attemptTrace();
    const response = await fetch(`${probe.origin}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ok",
      version: "v2",
      otlp: { status: 200 },
    });
    const robots = await fetch(`${probe.origin}/robots.txt`);
    expect(robots.status).toBe(200);
    expect(robots.headers.get("content-type")).toStartWith("text/plain");
    expect((await fetch(`${probe.origin}/missing`)).status).toBe(404);
  });

  test("answers credential routes without echoing or logging the query", async () => {
    const { fetchImpl } = collectorAnswering(200);
    const probe = await startProbe(fetchImpl);
    for (const route of sensitiveRoutes) {
      const response = await fetch(
        `${probe.origin}${route}?token=${marker}&code=${marker}`
      );
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).not.toContain(marker);
      expect(JSON.parse(body)).toEqual({ route, version: "v2" });
    }
    const logged = JSON.stringify(probe.logs);
    expect(logged).not.toContain(marker);
    expect(logged).not.toContain("?");
    expect(probe.logs).toContainEqual(
      expect.objectContaining({
        severity: "INFO",
        httpRequest: expect.objectContaining({
          requestMethod: "GET",
          requestUrl: "/app/auth/callback",
          status: 200,
        }),
      })
    );
  });

  test("sends one synthetic span to the collector and logs its status", async () => {
    const collector = collectorAnswering(200);
    const probe = await startProbe(collector.fetchImpl);
    const result = await probe.attemptTrace();
    expect(collector.calls).toHaveLength(1);
    expect(collector.calls[0]?.url).toBe("http://127.0.0.1:4318/v1/traces");
    expect(collector.calls[0]?.body).toMatchObject({
      resourceSpans: [
        {
          scopeSpans: [
            { spans: [{ traceId: result.traceId, name: expect.any(String) }] },
          ],
        },
      ],
    });
    expect(probe.logs).toContainEqual({
      severity: "INFO",
      message: "sandbox probe OTLP export attempt",
      otlp: { traceId: result.traceId, status: 200 },
    });
    // A delivered span is not resent on later requests.
    await fetch(`${probe.origin}/healthz`);
    expect(collector.calls).toHaveLength(1);
  });

  test("logs an unreachable collector and retries on the next request", async () => {
    let attempts = 0;
    const refused = fakeFetch(async () => {
      attempts += 1;
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }),
      });
    });
    const probe = await startProbe(refused);
    expect(await probe.attemptTrace()).toMatchObject({
      error: "ECONNREFUSED",
    });
    expect(probe.logs).toContainEqual(
      expect.objectContaining({
        severity: "WARNING",
        otlp: expect.objectContaining({ error: "ECONNREFUSED" }),
      })
    );
    expect((await fetch(`${probe.origin}/healthz`)).status).toBe(200);
    expect(attempts).toBe(2);
    // A collector that never answers is tried a bounded number of times.
    for (let request = 0; request < maxTraceAttempts * 2; request += 1) {
      await probe.attemptTrace();
      await fetch(`${probe.origin}/robots.txt`);
    }
    expect(attempts).toBe(maxTraceAttempts);
  });
});
