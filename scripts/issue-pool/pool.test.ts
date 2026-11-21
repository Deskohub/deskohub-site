import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Issue,
  IssuePool,
  type IssueTracker,
  runIssuePool,
  type WorkerRunner,
} from "./pool";
import type { Signal } from "./sources";

const logSignal: Signal = {
  key: "posthog:log:stable-pattern",
  title: "Workspace error",
  evidence: "A source reference",
  legacyMarkers: ["<!-- posthog-log-uuid:prior-event -->"],
  source: "posthog",
  observedAt: "2026-11-21T13:00:00Z",
  priority: "high",
};
const feedbackSignal: Signal = {
  key: "vercel:feedback:stable-thread",
  title: "Vercel feedback",
  evidence: "A feedback link",
  legacyMarkers: ["https://vercel.com/team/project/c/thread"],
  source: "vercel",
  observedAt: "2026-11-21T12:00:00Z",
  priority: "normal",
};

const issue = (number: number, body = ""): Issue => ({
  number,
  body,
  labels: [],
  assignees: [],
  state: "open",
  closedAt: null,
});

function fixture() {
  const issues: Issue[] = [];
  const workers = new Map<number, string>();
  const reported = new Set<number>();
  const launches: number[] = [];
  const tracker: IssueTracker = {
    list: async () => [...issues],
    file: async (_title, body) => {
      const created = issue(issues.length + 1, body);
      issues.push(created);
      return created;
    },
    hasOwner: async (number) => reported.has(number),
    recordWorker: async (number) => {
      reported.add(number);
    },
  };
  const runner: WorkerRunner = {
    find: async (number) => workers.get(number) ?? null,
    start: async (number) => {
      launches.push(number);
      const threadId = `worker-${number}`;
      workers.set(number, threadId);
      return threadId;
    },
  };
  return { issues, launches, tracker, runner };
}

const run = (
  pool: IssuePool,
  tracker: IssueTracker,
  runner: WorkerRunner,
  signals: Signal[],
  apply = true
) =>
  runIssuePool({
    pool,
    tracker,
    runner,
    signals,
    apply,
    maxNewIssues: 1,
    maxNewWorkers: 1,
  });

test("shares one priority, filing, and assignment policy across sources", async () => {
  const pool = new IssuePool(":memory:");
  const { issues, launches, tracker, runner } = fixture();
  try {
    const preview = await run(
      pool,
      tracker,
      runner,
      [feedbackSignal, logSignal],
      false
    );
    expect(preview.plannedIntake).toEqual([logSignal.key, feedbackSignal.key]);
    expect(issues).toEqual([]);
    expect(launches).toEqual([]);
    await run(pool, tracker, runner, [feedbackSignal, logSignal]);
    expect(issues.map(({ number }) => number)).toEqual([1]);
    expect(issues[0]?.body).toContain(logSignal.evidence);
    await run(pool, tracker, runner, [feedbackSignal, logSignal]);
    expect(issues[1]?.body).toContain(feedbackSignal.evidence);
    expect(launches).toEqual([1, 2]);
    await run(pool, tracker, runner, [feedbackSignal, logSignal]);
    expect(issues).toHaveLength(2);
    expect(launches).toEqual([1, 2]);
  } finally {
    pool.close();
  }
});

test("adopts legacy issues and respects a human assignee", async () => {
  const pool = new IssuePool(":memory:");
  const { issues, tracker, runner, launches } = fixture();
  try {
    issues.push(
      {
        ...issue(1, logSignal.legacyMarkers.join("\n")),
        assignees: ["maintainer"],
      },
      issue(2, feedbackSignal.legacyMarkers.join("\n")),
      issue(3, "An unrelated issue")
    );
    const result = await run(pool, tracker, runner, [
      logSignal,
      feedbackSignal,
    ]);
    expect(result.filed).toEqual([]);
    expect(launches).toEqual([2]);
  } finally {
    pool.close();
  }
});

test("reconciles an accepted launch whose response was lost across a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deskohub-issue-pool-"));
  const path = join(dir, "state.sqlite");
  const { launches, tracker, runner } = fixture();
  const uncertainRunner: WorkerRunner = {
    find: runner.find,
    async start(number) {
      await runner.start(number);
      throw new Error("Lost response");
    },
  };
  try {
    const first = new IssuePool(path);
    try {
      const result = await run(first, tracker, uncertainRunner, [logSignal]);
      expect(result.pendingAssignment).toEqual([1]);
    } finally {
      first.close();
    }
    const restarted = new IssuePool(path);
    try {
      const result = await run(restarted, tracker, runner, [logSignal]);
      expect(result.assigned).toEqual([1]);
      expect(launches).toEqual([1]);
    } finally {
      restarted.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keeps an ambiguous issue creation reserved and adopts it when it appears", async () => {
  const pool = new IssuePool(":memory:");
  const { issues, tracker, runner } = fixture();
  let created: Issue | undefined;
  let attempts = 0;
  const uncertainTracker: IssueTracker = {
    ...tracker,
    async file(_title, body) {
      attempts++;
      created = issue(1, body);
      throw new Error("Lost response");
    },
  };
  try {
    expect(
      (await run(pool, uncertainTracker, runner, [logSignal])).pendingIntake
    ).toEqual([logSignal.key]);
    expect(
      (await run(pool, uncertainTracker, runner, [logSignal])).pendingIntake
    ).toEqual([logSignal.key]);
    expect(attempts).toBe(1);
    if (!created) throw new Error("Expected an accepted issue");
    issues.push(created);
    expect(
      (await run(pool, uncertainTracker, runner, [logSignal])).assigned
    ).toEqual([1]);
  } finally {
    pool.close();
  }
});
