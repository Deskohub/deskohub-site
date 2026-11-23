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

const isTransientCode = (code: string) =>
  code.startsWith(transientConnectionClass) || transientCodes.has(code);

const isTransientMessage = <E>(error: E) =>
  error instanceof Error && transientDriverMessage.test(error.message);

// The first coded error in the chain decides, so a permanent SQLSTATE never
// retries whatever it wraps or says. Uncoded links decide by their message.
const hasTransientDriverCause = <E>(error: E, depth: number): boolean => {
  if (depth >= maxCauseDepth || !Predicate.hasProperty(error, "cause")) {
    return false;
  }
  const { cause } = error;
  if (Predicate.hasProperty(cause, "code") && Predicate.isString(cause.code)) {
    return isTransientCode(cause.code);
  }
  return isTransientMessage(cause) || hasTransientDriverCause(cause, depth + 1);
};

const isRetryableFailure = <E>(error: E) =>
  isRetryableEffectSqlFailure(error) ||
  (error instanceof DrizzleQueryError && hasTransientDriverCause(error, 0));

// `Effect.tryPromise` wraps a rejected promise's reason in an UnknownError.
const isRetryableDatabaseReadError = <E>(error: E) =>
  isRetryableFailure(Cause.isUnknownError(error) ? error.cause : error);

/**
 * Retries a read that failed on a transient database fault: a retryable
 * Effect SQL failure, or a node-postgres query (Better Auth's pool) that timed
 * out or lost its connection, also as the rejection `Effect.tryPromise`
 * wraps. Permanent database errors and other failures fail at once.
 */
export const retryDatabaseRead = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry({
      schedule: Schedule.spaced("100 millis"),
      times: 2,
      while: isRetryableDatabaseReadError,
    })
  );
