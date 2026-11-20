import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { isTracingSuppressed } from "@opentelemetry/core";
import { Effect, Fiber, Layer, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import {
  recordEffectTrace,
  startEffectTrace,
} from "@/shared/testing/effect-trace.test-utils";
import { FioMovements, type FioPeriod } from "./fio-movements.service";

const period: FioPeriod = {
  account: { accountNumber: "2111111111", bankCode: "2010" },
  readToken: Redacted.make("synthetic-fio-read-token"),
  from: "2026-07-12",
  to: "2026-07-13",
};

const bookingDate = Date.parse("2026-07-12T00:00:00+02:00");
const endDate = Date.parse("2026-07-13T00:00:00+02:00");

const movement = {
  column22: { value: 8412000001 },
  column0: { value: bookingDate },
  column1: { value: -1.13 },
  column14: { value: "CZK" },
  column5: { value: "0000000123" },
  column10: { value: "Synthetic Counterparty" },
};

const statement = {
  accountStatement: {
    info: {
      accountId: "2111111111",
      bankId: "2010",
      currency: "CZK",
      iban: "CZ8020100000002111111111",
      dateStart: bookingDate,
      dateEnd: endDate,
    },
    transactionList: { transaction: [movement] },
  },
};

beforeEach(() => {
  spyOn(globalThis, "fetch").mockImplementation(() =>
    Promise.reject(new Error("Unexpected global fetch in Fio fixture test"))
  );
});

afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  mock.restore();
});

const readPeriod = (
  fetchFixture: (
    url: RequestInfo | URL,
    init?: RequestInit
  ) => Promise<Response>,
  input = period
) =>
  Effect.gen(function* () {
    const fio = yield* FioMovements;
    return yield* fio.readPeriod(input);
  }).pipe(
    Effect.provide(
      FioMovements.Live.pipe(
        Layer.provide(
          Layer.succeed(
            FetchHttpClient.Fetch,
            Object.assign(fetchFixture, {
              preconnect: globalThis.fetch.preconnect,
            })
          )
        )
      )
    )
  );

test("reads a fixed HTTPS period and returns only the matched account's movement evidence", async () => {
  const requests: { url: string; method: string | undefined }[] = [];
  const effect = readPeriod((url, init) => {
    requests.push({ url: String(url), method: init?.method });
    return Promise.resolve(Response.json(statement));
  });

  expect(await Effect.runPromise(effect)).toEqual([
    {
      movementId: "8412000001",
      bookingDate: "2026-07-12",
      amount: { _tag: "CZK", minorUnits: -113 },
      reference: { _tag: "VariableSymbol", value: "123" },
    },
  ]);
  expect(requests).toEqual([
    {
      url: "https://fioapi.fio.cz/v1/rest/periods/synthetic-fio-read-token/2026-07-12/2026-07-13/transactions.json",
      method: "GET",
    },
  ]);
});

test("requires the receiving bank and full Czech account including its prefix", async () => {
  const account = {
    accountNumber: "2111111111",
    accountPrefix: "19",
    bankCode: "2010",
  };
  const info = {
    ...statement.accountStatement.info,
    iban: "CZ6620100000192111111111",
  };
  const read = (statementInfo: typeof info, expectedAccount = account) =>
    readPeriod(
      () =>
        Promise.resolve(
          Response.json({
            accountStatement: {
              ...statement.accountStatement,
              info: statementInfo,
            },
          })
        ),
      { ...period, account: expectedAccount }
    );

  expect(await Effect.runPromise(read(info))).toHaveLength(1);
  expect(
    await Effect.runPromise(read({ ...info, accountId: "0000192111111111" }))
  ).toHaveLength(1);
  expect(
    await Effect.runPromise(read({ ...info, accountId: "19-2111111111" }))
  ).toHaveLength(1);

  const mismatches = [
    read({ ...info, iban: statement.accountStatement.info.iban }),
    read({ ...info, iban: "CZ0420100000202111111111" }),
    read({ ...info, iban: "CZ0020100000192111111111" }),
    read({ ...info, accountId: "18-2111111111" }),
    read({ ...info, bankId: "0800" }),
    read({ ...info, accountId: "2111111112" }),
    read(info, { ...account, accountPrefix: "0" }),
  ];
  for (const mismatch of mismatches) {
    expect(await Effect.runPromise(Effect.flip(mismatch))).toMatchObject({
      _tag: "FioRejected",
      reason: "account-mismatch",
    });
  }
});

test("rejects malformed period bounds or token path segments before sending a request", async () => {
  const fetch = mock(() => Promise.resolve(Response.json(statement)));
  for (const input of [
    { ...period, from: "../last" },
    { ...period, to: "2026-07-32" },
    { ...period, from: "2026-07-14" },
    { ...period, readToken: Redacted.make("..") },
  ]) {
    expect(
      await Effect.runPromise(Effect.flip(readPeriod(fetch, input)))
    ).toMatchObject({
      _tag: "FioRejected",
      reason: "invalid-request",
    });
  }
  expect(fetch).not.toHaveBeenCalled();
});

test("fails closed when the requested history needs authorization, with one read and no cursor requests", async () => {
  const requests: string[] = [];
  const effect = readPeriod(
    (url) => {
      requests.push(String(url));
      return Promise.resolve(
        new Response("Synthetic bank error with private details", {
          status: 422,
        })
      );
    },
    { ...period, from: "2025-01-01" }
  );

  expect(await Effect.runPromise(Effect.flip(effect))).toMatchObject({
    _tag: "FioHistoryAccessRequired",
  });
  expect(requests).toEqual([
    "https://fioapi.fio.cz/v1/rest/periods/synthetic-fio-read-token/2025-01-01/2026-07-13/transactions.json",
  ]);
});

test("rejects partial coverage or a malformed movement instead of returning a partial batch", async () => {
  const { info } = statement.accountStatement;
  const responses = [
    Response.json(statement, { status: 206 }),
    Response.json({ accountStatement: { info } }),
    Response.json({
      accountStatement: {
        ...statement.accountStatement,
        info: { ...info, dateEnd: bookingDate },
      },
    }),
    Response.json({
      accountStatement: {
        info: { ...info, idTo: 8412000002 },
        transactionList: { transaction: [movement] },
      },
    }),
    Response.json({
      accountStatement: {
        info,
        transactionList: {
          transaction: [movement, { ...movement, column1: { value: 2 } }],
        },
      },
    }),
    Response.json({
      accountStatement: {
        info,
        transactionList: {
          transaction: [movement, { ...movement, column22: null }],
        },
      },
    }),
    Response.json({
      accountStatement: {
        info,
        transactionList: {
          transaction: [{ ...movement, column0: { value: "2026-07-14+0200" } }],
        },
      },
    }),
  ];
  for (const response of responses) {
    expect(
      await Effect.runPromise(
        Effect.flip(readPeriod(() => Promise.resolve(response)))
      )
    ).toMatchObject({
      _tag: "FioRejected",
    });
  }
  const empty = {
    accountStatement: { info, transactionList: { transaction: [] } },
  };
  expect(
    await Effect.runPromise(
      readPeriod(() => Promise.resolve(Response.json(empty)))
    )
  ).toEqual([]);
});

test("keeps large IDs and exact amounts while discarding invalid variable symbols", async () => {
  const { info } = statement.accountStatement;
  const body = JSON.stringify({
    accountStatement: {
      info,
      transactionList: {
        transaction: [
          {
            ...movement,
            column22: { value: "RAW_MOVEMENT_ID" },
            column1: { value: "RAW_CZK_AMOUNT" },
            column5: { value: "12 34" },
          },
          {
            ...movement,
            column22: { value: "8412000002" },
            column0: { value: "2026-07-13+0200" },
            column1: { value: "RAW_FOREIGN_AMOUNT" },
            column14: { value: "KWD" },
            column5: "invalid",
          },
          { ...movement, column22: { value: "8412000003" }, column5: null },
        ],
      },
    },
  })
    .replace('"RAW_MOVEMENT_ID"', "9007199254740995")
    .replace('"RAW_CZK_AMOUNT"', "90071992547409.91")
    .replace('"RAW_FOREIGN_AMOUNT"', "-123456789012345.123");

  expect(
    await Effect.runPromise(
      readPeriod(() => Promise.resolve(new Response(body)))
    )
  ).toEqual([
    {
      movementId: "9007199254740995",
      bookingDate: "2026-07-12",
      amount: { _tag: "CZK", minorUnits: 9007199254740991 },
      reference: { _tag: "Invalid" },
    },
    {
      movementId: "8412000002",
      bookingDate: "2026-07-13",
      amount: {
        _tag: "OtherCurrency",
        currency: "KWD",
        decimalAmount: "-123456789012345.123",
      },
      reference: { _tag: "Invalid" },
    },
    {
      movementId: "8412000003",
      bookingDate: "2026-07-12",
      amount: { _tag: "CZK", minorUnits: -113 },
      reference: { _tag: "Absent" },
    },
  ]);

  for (const amount of ["90071992547409.92", "0.00000000000000000001"]) {
    const response = new Response(body.replace("90071992547409.91", amount));
    expect(
      await Effect.runPromise(
        Effect.flip(readPeriod(() => Promise.resolve(response)))
      )
    ).toMatchObject({
      _tag: "FioRejected",
      reason: "invalid-response",
    });
  }
});

test("the request deadline aborts a stalled body without starting another read", async () => {
  const bodyStarted = Promise.withResolvers<void>();
  const requestSignals: (AbortSignal | null | undefined)[] = [];
  const effect = Effect.gen(function* () {
    const read = yield* Effect.forkChild(
      Effect.flip(
        readPeriod((_url, init) => {
          const signal = init?.signal;
          requestSignals.push(signal);
          const body = new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                bodyStarted.resolve();
                return new Promise<void>((resolve) => {
                  signal?.addEventListener(
                    "abort",
                    () => {
                      controller.error(new Error("Synthetic abort"));
                      resolve();
                    },
                    { once: true }
                  );
                });
              },
            },
            { highWaterMark: 0 }
          );
          return Promise.resolve(new Response(body));
        })
      )
    );
    yield* Effect.promise(() => bodyStarted.promise);
    yield* TestClock.adjust("10 seconds");
    return yield* Fiber.join(read);
  }).pipe(Effect.provide(TestClock.layer()));

  expect(await Effect.runPromise(effect)).toMatchObject({
    _tag: "FioUnavailable",
    reason: "timeout",
  });
  expect(requestSignals).toHaveLength(1);
  expect(requestSignals[0]?.aborted).toBe(true);
});

test("rejects an oversized response before decoding movement data", async () => {
  const response = Response.json(statement, {
    headers: { "content-length": "33554433" },
  });
  expect(
    await Effect.runPromise(
      Effect.flip(readPeriod(() => Promise.resolve(response)))
    )
  ).toMatchObject({
    _tag: "FioRejected",
    reason: "period-too-large",
  });
});

test("caps streamed response bytes even without a content length", async () => {
  const chunk = new Uint8Array(2 * 1024 * 1024);
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 17; index += 1) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    })
  );

  expect(
    await Effect.runPromise(
      Effect.flip(readPeriod(() => Promise.resolve(response)))
    )
  ).toMatchObject({ _tag: "FioRejected", reason: "period-too-large" });
});

test("keeps token-bearing URLs, transport causes, and malformed response bodies out of diagnostics", async () => {
  const trace = startEffectTrace();
  const instrumentedUrls: string[] = [];
  const bankBody = "Synthetic private bank response";
  const manager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(manager);

  try {
    const requestFailure = readPeriod((url) => {
      if (!isTracingSuppressed(context.active()))
        instrumentedUrls.push(String(url));
      return Promise.reject(new Error(`Failed to fetch ${url}: ${bankBody}`));
    });
    const decodeFailure = readPeriod((url) => {
      if (!isTracingSuppressed(context.active()))
        instrumentedUrls.push(String(url));
      return Promise.resolve(new Response(bankBody));
    });
    const diagnostics = await Effect.runPromise(
      recordEffectTrace(
        trace,
        Effect.all([Effect.flip(requestFailure), Effect.flip(decodeFailure)])
      )
    );

    expect(instrumentedUrls).toEqual([]);
    expect(trace.entries).toEqual([
      "span FioMovements.readPeriod",
      "span FioMovements.readPeriod",
    ]);
    expect(diagnostics).toMatchObject({
      _tag: "Success",
      value: [
        { _tag: "FioUnavailable", reason: "request-failed" },
        { _tag: "FioRejected", reason: "invalid-response" },
      ],
    });
    const serialized = Bun.inspect(diagnostics, { depth: 8 });
    expect(serialized).not.toContain("synthetic-fio-read-token");
    expect(serialized).not.toContain(bankBody);
  } finally {
    context.disable();
    manager.disable();
  }
});
