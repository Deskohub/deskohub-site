import { CloudinarySignatureRedactor } from "@deskohub/cloudinary/telemetry";
import * as OtelTracer from "@effect/opentelemetry/OtelTracer";
import * as OtelResource from "@effect/opentelemetry/Resource";
import type { TracerProvider } from "@opentelemetry/api";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type LogRecordExporter,
} from "@opentelemetry/sdk-logs";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { Data, Effect, Layer } from "effect";
import { createCensoredOtelSpanExporter } from "../logging/censorship";
import {
  createAllowlistedSpanExporter,
  SpanAllowlistProcessor,
} from "./span-allowlist";
import {
  isPostHogLogsExportEnabled,
  type PostHogLogsExport,
} from "./telemetry-policy";

/**
 * Builders for the Workspace's telemetry sinks: its service identity, the
 * span redaction stack, the PostHog OTLP log and trace exports, the Effect
 * tracer, and the bounded log flush. They read no environment, so the E2E
 * runner, which has no Workspace configuration, builds its trace export here
 * too. The Workspace process binds them to its configuration in
 * `workspace-telemetry.ts`.
 */

const WORKSPACE_SERVICE_NAME = "deskohub-workspace";
const WORKSPACE_SERVICE_NAMESPACE = "deskohub";

/** Who emits the telemetry. The service defaults to the Workspace. */
export interface TelemetryIdentity {
  readonly deploymentEnvironment?: string;
  readonly serviceName?: string;
  readonly serviceVersion?: string;
  readonly deploymentId?: string;
}

const identityResource = ({
  deploymentEnvironment,
  serviceName = WORKSPACE_SERVICE_NAME,
  serviceVersion,
  deploymentId,
}: TelemetryIdentity) =>
  resourceFromAttributes({
    "deployment.environment.name": deploymentEnvironment,
    "service.name": serviceName,
    "service.namespace": WORKSPACE_SERVICE_NAMESPACE,
    "service.version": serviceVersion,
    ...(deploymentId && { "deployment.id": deploymentId }),
  });

export interface WorkspaceOTelRegistrationOptions {
  /** The source commit the process serves. */
  readonly serviceVersion?: string | undefined;
  /** The host's rollout, such as a Cloud Run revision. */
  readonly deploymentId?: string | undefined;
  /**
   * A loopback OTLP/HTTP collector, such as the Cloud Run sidecar at
   * `http://127.0.0.1:4318`.
   */
  readonly otlpEndpoint?: string | undefined;
  /**
   * Whether `registerOTel` may add its automatic exporters when there is no
   * OTLP endpoint, as on Vercel (the default). A container host turns it off:
   * there they would send spans unfiltered to any OTLP endpoint the
   * environment names, or to `localhost:4318`.
   */
  readonly automaticExport?: boolean | undefined;
}

/**
 * `registerOTel` options for the Workspace server.
 *
 * By default, as on Vercel, they are the Workspace identity and the span
 * redactors ahead of `registerOTel`'s automatic exporting processors, as
 * they have always been.
 *
 * With an OTLP endpoint, as in a container, the span redactors and the span
 * allowlist run ahead of a single bounded batch export to that collector,
 * which applies the allowlist again, and no automatic exporter runs; the
 * identity adds the revision and the rollout. Without automatic export and
 * without an endpoint, spans are recorded and filtered but never exported.
 */
export const createWorkspaceOTelRegistration = ({
  serviceVersion,
  deploymentId,
  otlpEndpoint,
  automaticExport = true,
}: WorkspaceOTelRegistrationOptions = {}) => {
  if (!otlpEndpoint && automaticExport) {
    return {
      serviceName: WORKSPACE_SERVICE_NAME,
      attributes: { "service.namespace": WORKSPACE_SERVICE_NAMESPACE },
      spanProcessors: [...createWorkspaceSpanRedactors(), "auto" as const],
    };
  }
  return {
    serviceName: WORKSPACE_SERVICE_NAME,
    attributes: {
      "service.namespace": WORKSPACE_SERVICE_NAMESPACE,
      ...(serviceVersion && { "service.version": serviceVersion }),
      ...(deploymentId && { "deployment.id": deploymentId }),
    },
    spanProcessors: [
      ...createWorkspaceSpanRedactors(),
      new SpanAllowlistProcessor(),
      ...(otlpEndpoint ? [createCollectorSpanProcessor(otlpEndpoint)] : []),
    ],
  };
};

/** A loopback collector answers fast or is down; either way, don't wait. */
const collectorExportTimeoutMs = 1_000;

/**
 * The batch export to a loopback collector, which applies the span allowlist
 * again to what it exports. Its queue and batches are bounded, so a collector that is down drops spans instead of growing the
 * process's memory.
 */
const createCollectorSpanProcessor = (otlpEndpoint: string): SpanProcessor =>
  new BatchSpanProcessor(
    createAllowlistedSpanExporter(
      new OTLPTraceExporter({
        timeoutMillis: collectorExportTimeoutMs,
        url: new URL("/v1/traces", otlpEndpoint).toString(),
      })
    ),
    {
      exportTimeoutMillis: collectorExportTimeoutMs,
      maxExportBatchSize: 256,
      maxQueueSize: 2_048,
      scheduledDelayMillis: 1_000,
    }
  );

/**
 * Span processors that scrub credentials, such as signed Cloudinary URL
 * signatures, from span names and attributes. Every tracer provider built
 * here lists them ahead of its exporting span processor, whichever
 * instrumentation records the span.
 */
const createWorkspaceSpanRedactors = (): SpanProcessor[] => [
  new CloudinarySignatureRedactor(),
];

const postHogEndpoint = (posthogHost: string, path: string) =>
  new URL(path, posthogHost).toString();

const postHogExportTimeoutMs = 2_000;

interface PostHogSinkOptions extends TelemetryIdentity {
  readonly posthogHost?: string;
  readonly posthogProjectToken?: string;
}

/**
 * The longest attribute value a Workspace log record exports; the SDK cuts
 * longer strings to this length. Annotations that carried whole inventory
 * record arrays made single PostHog log rows of 25 KB and more.
 */
const logAttributeValueLengthLimit = 4_096;

/**
 * The provider that batches log records into `exporter` under `identity`,
 * with attribute values bounded. Tests pass the SDK's in-memory exporter.
 */
export const createWorkspaceLoggerProvider = (
  exporter: LogRecordExporter,
  identity: TelemetryIdentity
) =>
  new LoggerProvider({
    resource: identityResource(identity),
    logRecordLimits: {
      attributeValueLengthLimit: logAttributeValueLengthLimit,
    },
    processors: [
      new BatchLogRecordProcessor({
        exporter,
        exportTimeoutMillis: postHogExportTimeoutMs,
      }),
    ],
  });

interface PostHogLogSinkOptions extends PostHogSinkOptions {
  readonly logsExport?: PostHogLogsExport;
}

/**
 * The provider that exports log records to PostHog, or undefined without a
 * project token or when `logsExport` leaves the deployment's logs out.
 */
export function createPostHogLoggerProvider({
  logsExport,
  posthogHost,
  posthogProjectToken,
  ...identity
}: PostHogLogSinkOptions) {
  if (!posthogProjectToken) return undefined;
  if (
    !isPostHogLogsExportEnabled({
      deploymentEnvironment: identity.deploymentEnvironment,
      logsExport,
    })
  ) {
    return undefined;
  }
  if (!posthogHost) {
    throw new Error(
      "POSTHOG_INGEST_HOST is required when PostHog logging is enabled"
    );
  }
  if (!identity.deploymentEnvironment) {
    throw new Error(
      "The deployment stage (WORKSPACE_DEPLOYMENT_STAGE or VERCEL_ENV) is required when PostHog logging is enabled"
    );
  }

  return createWorkspaceLoggerProvider(
    new OTLPLogExporter({
      headers: {
        Authorization: `Bearer ${posthogProjectToken}`,
        "Content-Type": "application/json",
      },
      timeoutMillis: postHogExportTimeoutMs,
      url: postHogEndpoint(posthogHost, "/i/v1/logs"),
    }),
    identity
  );
}

/**
 * The provider that redacts and censors spans before it batches them into
 * `exporter` under `identity`. Tests pass the SDK's in-memory exporter.
 */
export const createWorkspaceTracerProvider = (
  exporter: SpanExporter,
  identity: TelemetryIdentity
) =>
  new BasicTracerProvider({
    resource: identityResource(identity),
    spanProcessors: [
      ...createWorkspaceSpanRedactors(),
      new BatchSpanProcessor(createCensoredOtelSpanExporter(exporter), {
        exportTimeoutMillis: postHogExportTimeoutMs,
      }),
    ],
  });

/**
 * The provider that exports redacted, censored spans to PostHog, or
 * undefined without a project token.
 */
export function createPostHogTracerProvider({
  posthogHost,
  posthogProjectToken,
  ...identity
}: PostHogSinkOptions) {
  if (!posthogProjectToken) return undefined;
  if (!posthogHost) {
    throw new Error(
      "POSTHOG_INGEST_HOST is required when PostHog tracing is enabled"
    );
  }

  return createWorkspaceTracerProvider(
    new OTLPTraceExporter({
      headers: { Authorization: `Bearer ${posthogProjectToken}` },
      timeoutMillis: postHogExportTimeoutMs,
      url: postHogEndpoint(posthogHost, "/i/v1/traces"),
    }),
    identity
  );
}

interface TracingLiveOptions {
  readonly attributes?: Record<string, boolean | number | string>;
  readonly provider?: TracerProvider;
  readonly serviceName: string;
  readonly serviceVersion?: string;
}

/**
 * The Effect tracer over `provider`, or over the global tracer provider that
 * `registerOTel` installs when there is none.
 */
export const createTracingLive = ({
  attributes,
  provider,
  serviceName,
  serviceVersion,
}: TracingLiveOptions) => {
  const providerLive = provider
    ? Layer.succeed(OtelTracer.OtelTracerProvider, provider)
    : OtelTracer.layerGlobalProvider;
  const resourceLive = OtelResource.layer({
    attributes,
    serviceName,
    serviceVersion,
  });

  return OtelTracer.layer.pipe(
    Layer.provide(Layer.merge(providerLive, resourceLive))
  );
};

/** The Effect tracer for `identity`, over `provider` or the global one. */
export const createIdentifiedTracingLive = (
  { deploymentEnvironment, serviceName, serviceVersion }: TelemetryIdentity,
  provider?: TracerProvider
) =>
  createTracingLive({
    attributes: {
      ...(deploymentEnvironment && {
        "deployment.environment.name": deploymentEnvironment,
      }),
      "service.namespace": WORKSPACE_SERVICE_NAMESPACE,
    },
    provider,
    serviceName: serviceName ?? WORKSPACE_SERVICE_NAME,
    serviceVersion,
  });

class LogFlushError extends Data.TaggedError("LogFlushError")<{
  readonly cause: unknown;
}> {}

/**
 * Exports the log records `provider` still buffers within the post-response
 * deadline. Never fails: a rejected or overdue flush is logged as a warning.
 */
export const flushLoggerProvider = (
  provider: Pick<LoggerProvider, "forceFlush"> | undefined,
  timeoutMs = postHogExportTimeoutMs
): Effect.Effect<void> =>
  provider
    ? Effect.tryPromise({
        try: () => provider.forceFlush({ timeoutMillis: timeoutMs }),
        catch: (cause) => new LogFlushError({ cause }),
      }).pipe(
        Effect.timeout(timeoutMs),
        Effect.catchTags({
          LogFlushError: ({ cause }) =>
            Effect.logWarning("PostHog log flush failed.", { cause }),
          TimeoutError: () =>
            Effect.logWarning(
              "PostHog log flush exceeded its post-response deadline."
            ),
        })
      )
    : Effect.void;
