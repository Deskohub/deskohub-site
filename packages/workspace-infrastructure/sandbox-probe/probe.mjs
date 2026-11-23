// The disposable synthetic probe the hosted sandbox proof deploys in place of
// the Workspace image. It holds no secrets and has no dependencies: it serves
// a few fixed routes, writes Cloud Logging structured JSON to stdout, and
// sends one synthetic OTLP/HTTP span to the loopback collector sidecar.
//
// Logs carry the request path only. A query string, its token values and
// request headers never reach a log line or a response body.

import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

/** The loopback OTLP/HTTP receiver of the collector sidecar. */
export const defaultOtlpEndpoint = "http://127.0.0.1:4318";

/** Routes that stand in for credential-bearing Workspace links. */
export const sensitiveRoutes = [
  "/app/auth/callback",
  "/api/auth/magic-link/verify",
  "/marketing-preferences/access",
];

const healthRoutes = ["/healthz", "/probe/health"];

/** Synthetic span attempts per process while none reaches the collector. */
export const maxTraceAttempts = 5;

const robots = "User-agent: *\nDisallow: /\n";

/** One Cloud Logging structured entry on stdout. */
export const stdoutLog = (entry) => {
  process.stdout.write(`${JSON.stringify(entry)}\n`);
};

/** The request path alone; a malformed target logs as "/". */
const requestPath = (target) => {
  try {
    return new URL(target ?? "/", "http://probe.invalid").pathname;
  } catch {
    return "/";
  }
};

const hex = (bytes) => randomBytes(bytes).toString("hex");

/** A single synthetic span in OTLP/HTTP JSON form. */
export const syntheticTrace = (version, traceId, spanId, nowMs) => {
  const start = BigInt(nowMs) * 1_000_000n;
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            {
              key: "service.name",
              value: { stringValue: "workspace-sandbox-probe" },
            },
            { key: "service.version", value: { stringValue: version } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "workspace-sandbox-probe" },
            spans: [
              {
                traceId,
                spanId,
                name: "sandbox-probe.synthetic",
                kind: 1,
                startTimeUnixNano: String(start),
                endTimeUnixNano: String(start + 1_000_000n),
                attributes: [
                  {
                    key: "probe.version",
                    value: { stringValue: version },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
};

/**
 * Send one synthetic span and log the outcome: the HTTP status the
 * collector answered with, or the connection error. It never throws.
 */
export const sendSyntheticTrace = async ({
  version,
  otlpEndpoint,
  timeoutMs,
  log,
  fetchImpl = fetch,
  now = Date.now,
}) => {
  const traceId = hex(16);
  const url = `${otlpEndpoint.replace(/\/+$/, "")}/v1/traces`;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(syntheticTrace(version, traceId, hex(8), now())),
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel();
    const result = { traceId, status: response.status };
    log({
      severity: response.ok ? "INFO" : "WARNING",
      message: "sandbox probe OTLP export attempt",
      otlp: result,
    });
    return result;
  } catch (error) {
    const result = {
      traceId,
      error: String(error?.cause?.code ?? error?.name ?? "Error"),
    };
    log({
      severity: "WARNING",
      message: "sandbox probe OTLP export attempt",
      otlp: result,
    });
    return result;
  }
};

const send = (response, status, contentType, body) => {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  response.end(body);
};

const sendJson = (response, status, body) =>
  send(response, status, "application/json", JSON.stringify(body));

/**
 * The probe's HTTP server. The OTLP attempt runs at startup and, until one
 * gets an HTTP status, again on later requests, at most
 * `maxTraceAttempts` times in all, so a missing collector stays quiet.
 */
export const createProbeServer = ({
  version,
  otlpEndpoint = defaultOtlpEndpoint,
  otlpTimeoutMs = 2000,
  log = stdoutLog,
  fetchImpl,
}) => {
  let otlp = null;
  let pending = null;
  let attempts = 0;
  const attemptTrace = () => {
    if (pending === null && attempts >= maxTraceAttempts) {
      return Promise.resolve(otlp);
    }
    if (pending === null) {
      attempts += 1;
    }
    pending ??= sendSyntheticTrace({
      version,
      otlpEndpoint,
      timeoutMs: otlpTimeoutMs,
      log,
      fetchImpl,
    }).then((result) => {
      otlp = result;
      pending = null;
      return result;
    });
    return pending;
  };

  const server = createServer((request, response) => {
    const startedAt = process.hrtime.bigint();
    const path = requestPath(request.url);
    const method = request.method ?? "GET";
    if (otlp?.status === undefined) {
      attemptTrace();
    }
    if (method !== "GET" && method !== "HEAD") {
      sendJson(response, 405, { error: "method-not-allowed" });
    } else if (healthRoutes.includes(path)) {
      sendJson(response, 200, { status: "ok", version, otlp });
    } else if (path === "/robots.txt") {
      send(response, 200, "text/plain; charset=utf-8", robots);
    } else if (sensitiveRoutes.includes(path)) {
      sendJson(response, 200, { route: path, version });
    } else {
      sendJson(response, 404, { error: "not-found" });
    }
    const latencySeconds =
      Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
    log({
      severity: response.statusCode >= 500 ? "ERROR" : "INFO",
      message: `${method} ${path} ${response.statusCode}`,
      httpRequest: {
        requestMethod: method,
        requestUrl: path,
        status: response.statusCode,
        latency: `${latencySeconds.toFixed(6)}s`,
      },
      probeVersion: version,
    });
  });
  return { server, attemptTrace, lastTrace: () => otlp };
};
