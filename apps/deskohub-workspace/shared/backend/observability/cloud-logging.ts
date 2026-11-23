import {
  Cause,
  Context,
  Logger,
  type LogLevel,
  Option,
  Predicate,
  References,
  Result,
  Tracer,
} from "effect";
import { censorLoggerOptions } from "../logging/censorship";

/**
 * Workspace log records as Cloud Logging structured JSON: one object per
 * stdout line, which the Cloud Run logging agent parses into a LogEntry.
 * The record carries the Workspace's identity and the active trace and span,
 * and every value passes through the shared censor first. Only the field
 * names are Google's; nothing here calls a Google SDK.
 * https://cloud.google.com/logging/docs/structured-logging
 */

/** Who emits a record, as labels every record repeats. */
export interface CloudLoggingIdentity {
  readonly deploymentStage?: string | undefined;
  readonly serviceRole: string;
  readonly revisionSha?: string | undefined;
  readonly deploymentId?: string | undefined;
  /**
   * The Google Cloud project whose trace store holds the spans; Cloud
   * Logging links a record to its trace only through this project's trace
   * name. Without it the record keeps the bare trace id.
   */
  readonly traceProjectId?: string | undefined;
}

const cloudLoggingSeverity = (logLevel: LogLevel.LogLevel) => {
  switch (logLevel) {
    case "Fatal":
      return "CRITICAL";
    case "Error":
      return "ERROR";
    case "Warn":
      return "WARNING";
    case "Info":
      return "INFO";
    case "Debug":
    case "Trace":
      return "DEBUG";
    default:
      return "DEFAULT";
  }
};

interface CloudLoggingLabels {
  readonly environment: string | undefined;
  readonly service_role: string;
  readonly revision: string | undefined;
  readonly deployment_id: string | undefined;
}

type LogAnnotations = ReturnType<typeof logAnnotations>;

const logAnnotations = (options: Logger.Options<unknown>) =>
  options.fiber.getRef(References.CurrentLogAnnotations);

/**
 * One Cloud Logging record. JSON leaves out the fields that are undefined.
 * https://cloud.google.com/logging/docs/agent/logging/configuration#special-fields
 */
export interface CloudLoggingRecord {
  readonly severity: string;
  readonly message: string;
  readonly time: string;
  readonly "logging.googleapis.com/labels": CloudLoggingLabels;
  readonly "logging.googleapis.com/trace"?: string | undefined;
  readonly "logging.googleapis.com/spanId"?: string | undefined;
  readonly "logging.googleapis.com/trace_sampled"?: boolean | undefined;
  readonly trace_id?: string | undefined;
  readonly annotations?: LogAnnotations | undefined;
  readonly details?: readonly unknown[] | undefined;
  readonly spans?: Readonly<Record<string, string>> | undefined;
  readonly cause?: string | undefined;
}

const traceFields = (
  options: Logger.Options<unknown>,
  traceProjectId: string | undefined
) => {
  const span = Context.getOption(options.fiber.context, Tracer.ParentSpan);
  if (Option.isNone(span)) return {};
  const { traceId, spanId, sampled } = span.value;
  return {
    "logging.googleapis.com/trace": traceProjectId
      ? `projects/${traceProjectId}/traces/${traceId}`
      : undefined,
    "logging.googleapis.com/spanId": spanId,
    "logging.googleapis.com/trace_sampled": sampled,
    trace_id: traceProjectId ? undefined : traceId,
  };
};

const logSpanDurations = (options: Logger.Options<unknown>) => {
  const now = options.date.getTime();
  const spans = options.fiber.getRef(References.CurrentLogSpans);
  return spans.length === 0
    ? undefined
    : Object.fromEntries(
        spans.map(([label, startedAt]) => [label, `${now - startedAt}ms`])
      );
};

/**
 * The censored structured record of one log call. The message is the static
 * text of the call; values the call passes beside it go under `details`.
 */
export const cloudLoggingRecord = (
  identity: CloudLoggingIdentity,
  rawOptions: Logger.Options<unknown>
): CloudLoggingRecord => {
  const options = censorLoggerOptions(rawOptions);
  const parts: readonly unknown[] = Array.isArray(options.message)
    ? options.message
    : [options.message];
  const details = parts.filter((part) => !Predicate.isString(part));
  const annotations = logAnnotations(options);

  return {
    severity: cloudLoggingSeverity(options.logLevel),
    message: parts.filter(Predicate.isString).join(" "),
    time: options.date.toISOString(),
    "logging.googleapis.com/labels": {
      environment: identity.deploymentStage,
      service_role: identity.serviceRole,
      revision: identity.revisionSha,
      deployment_id: identity.deploymentId,
    },
    ...traceFields(options, identity.traceProjectId),
    annotations: Object.keys(annotations).length > 0 ? annotations : undefined,
    details: details.length > 0 ? details : undefined,
    spans: logSpanDurations(options),
    cause:
      options.cause.reasons.length === 0
        ? undefined
        : Cause.pretty(options.cause),
  };
};

/** The envelope of a record whose values JSON can't encode. */
const unserializableRecord = (record: CloudLoggingRecord) =>
  JSON.stringify({
    severity: record.severity,
    message: record.message,
    time: record.time,
    "logging.googleapis.com/labels": record["logging.googleapis.com/labels"],
    serialization: "failed",
  });

/** One JSON line per record. */
const formatCloudLoggingLine = (record: CloudLoggingRecord) =>
  Result.try(() => JSON.stringify(record)).pipe(
    Result.getOrElse(() => unserializableRecord(record))
  );

/** The censoring Cloud Logging logger, writing one JSON line to stdout. */
export const makeCloudLoggingLogger = (identity: CloudLoggingIdentity) =>
  Logger.withConsoleLog(
    Logger.make((options) =>
      formatCloudLoggingLine(cloudLoggingRecord(identity, options))
    )
  );
