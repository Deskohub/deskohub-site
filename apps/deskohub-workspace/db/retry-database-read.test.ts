import { expect, test } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Cause, Effect } from "effect";
import * as SqlError from "effect/sql/SqlError";
import { withInstantSleeps } from "@/shared/testing/workspace-test-clock.test-utils";
import { retryDatabaseRead } from "./retry-database-read";

test("retries a failed database read once", async () => {
  let attempts = 0;
  const result = await Effect.suspend(() => {
    attempts += 1;
    return attempts === 1
      ? Effect.fail(
          new EffectDrizzleQueryError({
            query: "select 1",
            params: [],
            cause: Cause.fail(
              new SqlError.SqlError({
                reason: new SqlError.ConnectionError({
                  cause: new Error("timeout exceeded when trying to connect"),
                  message: "timeout exceeded when trying to connect",
                  operation: "connect",
                }),
              })
            ),
          })
        )
      : Effect.succeed("loaded");
  }).pipe(retryDatabaseRead, Effect.runPromise);

  expect(result).toBe("loaded");
  expect(attempts).toBe(2);
});

test("retries uncoded connection acquisition failures", async () => {
  let attempts = 0;
  const result = await Effect.suspend(() => {
    attempts += 1;
    return attempts <= 2
      ? Effect.fail(
          new EffectDrizzleQueryError({
            query: "select 1",
            params: [],
            cause: Cause.fail(
              new SqlError.SqlError({
                reason: new SqlError.UnknownError({
                  cause: new Error("timeout exceeded when trying to connect"),
                  message: "Failed to acquire connection",
                  operation: "acquireConnection",
                }),
              })
            ),
          })
        )
      : Effect.succeed("loaded");
  }).pipe(retryDatabaseRead, Effect.runPromise);

  expect(result).toBe("loaded");
  expect(attempts).toBe(3);
});

test("does not retry coded unknown connection acquisition failures", async () => {
  let attempts = 0;
  const failure = new EffectDrizzleQueryError({
    query: "select 1",
    params: [],
    cause: Cause.fail(
      new SqlError.SqlError({
        reason: new SqlError.UnknownError({
          cause: Object.assign(new Error("database does not exist"), {
            code: "3D000",
          }),
          message: "Failed to acquire connection",
          operation: "acquireConnection",
        }),
      })
    ),
  });

  const result = await Effect.suspend(() => {
    attempts += 1;
    return Effect.fail(failure);
  }).pipe(retryDatabaseRead, Effect.flip, Effect.runPromise);

  expect(result).toBe(failure);
  expect(attempts).toBe(1);
});

test("does not retry a permanent database read failure", async () => {
  let attempts = 0;
  const failure = new EffectDrizzleQueryError({
    query: "select invalid",
    params: [],
    cause: Cause.fail(
      new SqlError.SqlError({
        reason: new SqlError.SqlSyntaxError({
          cause: new Error("syntax error"),
          message: "syntax error",
          operation: "execute",
        }),
      })
    ),
  });

  const result = await Effect.suspend(() => {
    attempts += 1;
    return Effect.fail(failure);
  }).pipe(retryDatabaseRead, Effect.flip, Effect.runPromise);

  expect(result).toBe(failure);
  expect(attempts).toBe(1);
});

const codedError = (message: string, code: string) =>
  Object.assign(new Error(message), { code });

const nodePostgresFailure = (cause: Error) =>
  new DrizzleQueryError(
    'select "id" from "auth"."oauth_resource" where "identifier" = $1',
    ["https://deskohub.test/api/mcp"],
    cause
  );

const failingAttempts = (failure: Error, failures: number) => {
  let attempts = 0;
  const effect = Effect.suspend(() => {
    attempts += 1;
    return attempts <= failures
      ? Effect.fail(failure)
      : Effect.succeed("loaded");
  });
  return { effect, attempts: () => attempts };
};

test.each([
  ["a query read timeout", new Error("Query read timeout")],
  [
    "a connection timeout",
    new Error("Connection terminated due to connection timeout", {
      cause: new Error("Connection terminated unexpectedly"),
    }),
  ],
  ["a dropped connection", new Error("Connection terminated unexpectedly")],
  ["an admin shutdown", codedError("terminating connection", "57P01")],
  ["a connection failure", codedError("connection failure", "08006")],
  ["a serialization failure", codedError("could not serialize", "40001")],
  ["a reset socket", codedError("read ECONNRESET", "ECONNRESET")],
  ["a refused socket", codedError("connect ECONNREFUSED", "ECONNREFUSED")],
])("retries a node-postgres read that failed on %s", async (_, cause) => {
  const read = failingAttempts(nodePostgresFailure(cause), 2);

  const result = await read.effect.pipe(
    retryDatabaseRead,
    withInstantSleeps,
    Effect.runPromise
  );

  expect(result).toBe("loaded");
  expect(read.attempts()).toBe(3);
});

test("fails a node-postgres read once its retries are exhausted", async () => {
  const failure = nodePostgresFailure(new Error("Query read timeout"));
  const read = failingAttempts(failure, Number.POSITIVE_INFINITY);

  const result = await read.effect.pipe(
    retryDatabaseRead,
    Effect.flip,
    withInstantSleeps,
    Effect.runPromise
  );

  expect(result).toBe(failure);
  expect(read.attempts()).toBe(3);
});

test.each([
  ["a missing database", nodePostgresFailure(codedError("no db", "3D000"))],
  [
    "a missing table",
    nodePostgresFailure(
      codedError('relation "auth.oauth_resource" does not exist', "42P01")
    ),
  ],
  ["a missing column", nodePostgresFailure(codedError("no column", "42703"))],
  [
    "a syntax error",
    nodePostgresFailure(codedError('syntax error at or near "selec"', "42601")),
  ],
  [
    "rejected credentials",
    nodePostgresFailure(codedError("password authentication failed", "28P01")),
  ],
  [
    "a coded error whose message reads like a dropped connection",
    nodePostgresFailure(codedError("Connection terminated", "42P01")),
  ],
  [
    "a connection timeout around rejected credentials",
    nodePostgresFailure(
      new Error("timeout exceeded when trying to connect", {
        cause: codedError("password authentication failed", "28P01"),
      })
    ),
  ],
  [
    "a failure whose causes form a cycle",
    (() => {
      const cyclic = new Error("unexpected driver state");
      cyclic.cause = cyclic;
      return nodePostgresFailure(cyclic);
    })(),
  ],
  [
    "a permanent error that wraps a dropped connection",
    nodePostgresFailure(
      Object.assign(codedError("no db", "3D000"), {
        cause: codedError("read ECONNRESET", "ECONNRESET"),
      })
    ),
  ],
  [
    "a Better Auth API error",
    Object.assign(new Error("Invalid token"), {
      name: "APIError",
      statusCode: 401,
      cause: new Error("Query read timeout"),
    }),
  ],
  ["a plain timeout outside a query", new Error("Query read timeout")],
])("does not retry %s", async (_, failure) => {
  const read = failingAttempts(failure, 1);

  const result = await read.effect.pipe(
    retryDatabaseRead,
    Effect.flip,
    withInstantSleeps,
    Effect.runPromise
  );

  expect(result).toBe(failure);
  expect(read.attempts()).toBe(1);
});

test("retries a timed-out node-postgres read that a promise rejected with", async () => {
  let attempts = 0;
  const result = await Effect.tryPromise(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw nodePostgresFailure(new Error("Query read timeout"));
    }
    return "loaded";
  }).pipe(retryDatabaseRead, withInstantSleeps, Effect.runPromise);

  expect(result).toBe("loaded");
  expect(attempts).toBe(2);
});

test("does not retry a Better Auth API error that a promise rejected with", async () => {
  let attempts = 0;
  const result = await Effect.tryPromise(async () => {
    attempts += 1;
    throw Object.assign(new Error("Invalid token"), { name: "APIError" });
  }).pipe(retryDatabaseRead, Effect.flip, withInstantSleeps, Effect.runPromise);

  expect(result.cause).toMatchObject({ name: "APIError" });
  expect(attempts).toBe(1);
});
