import { DrizzleQueryError } from "drizzle-orm";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Cause, Effect, Predicate, Schedule } from "effect";
import { SqlError } from "effect/sql";

// Query error, driver error, and the error a dropped connection wraps. The
// bound only guards against cyclic causes.
const maxCauseDepth = 8;

// Codes a later attempt can clear: SQLSTATE class 08 (connection exception),
// a server shutting down or starting up (57P01-57P03), serialization failures
// and deadlocks (40001, 40P01), and socket failures between Node and the pool.
const transientConnectionClass = "08";
const transientCodes = new Set([
  "57P01",
  "57P02",
  "57P03",
  "40001",
  "40P01",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ECONNREFUSED",
]);

// node-postgres raises these without a code when a query or connection times
// out, or the server drops the connection.
const transientDriverMessage =
  /Query read timeout|Connection terminated|timeout exceeded when trying to connect/i;

const isRetryableEffectSqlFailure = <E>(error: E) =>
  error instanceof EffectDrizzleQueryError &&
  Cause.isCause(error.cause) &&
  error.cause.reasons.some(
    (reason) =>
      Cause.isFailReason(reason) &&
      SqlError.isSqlError(reason.error) &&
      (reason.error.isRetryable ||
        (reason.error.reason._tag === "UnknownError" &&
          (!Predicate.hasProperty(reason.error.reason.cause, "code") ||
            !Predicate.isString(reason.error.reason.cause.code))))
  );

// A coded error is judged by its code alone, so a permanent SQLSTATE never
// retries whatever its message says.
const isTransientDriverError = <E>(error: E) =>
  Predicate.hasProperty(error, "code") && Predicate.isString(error.code)
    ? error.code.startsWith(transientConnectionClass) ||
      transientCodes.has(error.code)
    : error instanceof Error && transientDriverMessage.test(error.message);

const hasTransientDriverCause = <E>(error: E, depth: number): boolean =>
  depth < maxCauseDepth &&
  Predicate.hasProperty(error, "cause") &&
  (isTransientDriverError(error.cause) ||
    hasTransientDriverCause(error.cause, depth + 1));

const isRetryableDatabaseReadError = <E>(error: E) =>
  isRetryableEffectSqlFailure(error) ||
  (error instanceof DrizzleQueryError && hasTransientDriverCause(error, 0));

/**
 * Retries a read that failed on a transient database fault: a retryable
 * Effect SQL failure, or a node-postgres query (Better Auth's pool) that timed
 * out or lost its connection. Permanent database errors and other failures
 * fail at once.
 */
export const retryDatabaseRead = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry({
      schedule: Schedule.spaced("100 millis"),
      times: 2,
      while: isRetryableDatabaseReadError,
    })
  );
