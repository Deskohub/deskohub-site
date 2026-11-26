import { expect, test } from "bun:test";
import {
  classifyUnlimitedRecoveryPayment,
  originalUnlimitedRun,
  verifyCancelledUnlimitedNexiOrder,
  verifyOriginalUnlimitedRun,
} from "./unlimited-pass-recovery-evidence";

const orderId = "DFIXTURE";
const expected = { orderId, amount: 418_000 };
const orderStatus = {
  order: { orderId, currency: "EUR", amount: "418000" },
  authorizedAmount: "0",
  capturedAmount: "0",
};
const operation = {
  operationId: "synthetic-cancelled",
  operationType: "AUTHORIZATION",
  operationResult: "CANCELED",
};
const cancelled = { orderStatus, operations: [operation] };

test("binds a cancelled zero-money authorization to the exact sandbox order", () => {
  expect(verifyCancelledUnlimitedNexiOrder(cancelled, expected)).toBe(
    operation.operationId
  );
  for (const response of [
    {
      ...cancelled,
      operations: [{ ...operation, operationResult: "EXECUTED" }],
    },
    {
      ...cancelled,
      operations: [{ ...operation, operationResult: "unknown" }],
    },
    { ...cancelled, operations: [operation, operation] },
    { ...cancelled, orderStatus: { ...orderStatus, authorizedAmount: "1" } },
    {
      ...cancelled,
      orderStatus: { ...orderStatus, capturedAmount: undefined },
    },
    {
      ...cancelled,
      orderStatus: {
        ...orderStatus,
        order: { ...orderStatus.order, currency: "CZK" },
      },
    },
  ]) {
    expect(() =>
      verifyCancelledUnlimitedNexiOrder(response, expected)
    ).toThrow();
  }
  expect(() =>
    verifyCancelledUnlimitedNexiOrder(cancelled, {
      ...expected,
      orderId: "DOTHER",
    })
  ).toThrow();
  expect(() =>
    verifyCancelledUnlimitedNexiOrder(cancelled, {
      ...expected,
      amount: expected.amount + 1,
    })
  ).toThrow();
});

test("separates unattempted holds and the idempotent provider-verified terminal state", () => {
  const pending = {
    paymentState: "pending",
    purchaseState: "pending_payment",
    activeAttemptId: "attempt",
    attempts: [
      {
        id: "attempt",
        provider: "nexi",
        state: "pending",
        failureCode: null,
        lastProviderStatus: null,
      },
    ],
  };
  expect(classifyUnlimitedRecoveryPayment(pending)).toBe("pending");
  expect(
    classifyUnlimitedRecoveryPayment({
      paymentState: "not_started",
      purchaseState: "pending_payment",
      activeAttemptId: null,
      attempts: [],
    })
  ).toBe("unattempted");
  const terminal = {
    ...pending,
    paymentState: "cancelled",
    purchaseState: "void",
    attempts: [
      {
        ...pending.attempts[0],
        id: "attempt",
        provider: "nexi",
        state: "cancelled",
        failureCode: "nexi_payment_failed",
        lastProviderStatus: "CANCELED",
      },
    ],
  };
  expect(classifyUnlimitedRecoveryPayment(terminal)).toBe("cancelled");
  expect(classifyUnlimitedRecoveryPayment(terminal)).toBe("cancelled");
  for (const unsafe of [
    { ...pending, paymentState: "paid" },
    { ...terminal, activeAttemptId: "different" },
    { ...pending, attempts: [...pending.attempts, ...pending.attempts] },
    { ...terminal, purchaseState: "active" },
    {
      ...terminal,
      attempts: terminal.attempts.map((attempt) => ({
        ...attempt,
        lastProviderStatus: "FAILED",
      })),
    },
  ]) {
    expect(() => classifyUnlimitedRecoveryPayment(unsafe)).toThrow();
  }
});

test("accepts only the original failed workflow and its released checkout allocation", () => {
  const run = {
    id: Number(originalUnlimitedRun.id),
    run_attempt: originalUnlimitedRun.attempt,
    head_sha: originalUnlimitedRun.sha,
    head_branch: originalUnlimitedRun.branch,
    event: "workflow_dispatch",
    path: ".github/workflows/workspace-e2e.yml",
    status: "completed",
    conclusion: "failure",
    head_repository: { full_name: originalUnlimitedRun.repository },
  };
  const job = {
    name: "test-e2e",
    started_at: originalUnlimitedRun.startedAt,
    completed_at: originalUnlimitedRun.completedAt,
    conclusion: "failure",
    steps: [
      { name: "Lease an available date shard", conclusion: "success" },
      { name: "Release date shard", conclusion: "success" },
    ],
  };
  expect(() => verifyOriginalUnlimitedRun(run, { jobs: [job] })).not.toThrow();
  for (const bad of [
    { id: 1 },
    { run_attempt: 2 },
    { head_sha: "foreign" },
    { event: "push" },
  ]) {
    expect(() =>
      verifyOriginalUnlimitedRun({ ...run, ...bad }, { jobs: [job] })
    ).toThrow();
  }
  expect(() =>
    verifyOriginalUnlimitedRun(run, { jobs: [{ ...job, steps: [] }] })
  ).toThrow();
});
