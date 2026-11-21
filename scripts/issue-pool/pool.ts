import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { Signal } from "./sources";

export interface Issue {
  number: number;
  state: "open" | "closed";
  closedAt: string | null;
  body: string;
  labels: readonly string[];
  assignees: readonly string[];
}

export interface IssueTracker {
  list(): Promise<readonly Issue[]>;
  file(title: string, body: string): Promise<Issue>;
  hasOwner(number: number): Promise<boolean>;
  recordWorker(number: number, threadId: string): Promise<void>;
}

export interface WorkerRunner {
  find(number: number): Promise<string | null>;
  start(number: number): Promise<string>;
}

interface Claim {
  threadId: string | null;
  reported: number;
}

export interface PassResult {
  filed: number[];
  assigned: number[];
  pendingIntake: string[];
  pendingAssignment: number[];
  plannedIntake: string[];
  plannedAssignment: number[];
}

const issuePoolLabel = "issue-pool";
const sourceMarker = (key: string) =>
  `<!-- issue-pool-source:${createHash("sha256").update(key).digest("hex")} -->`;

const ownedByPool = (issue: Issue) =>
  issue.labels.includes(issuePoolLabel) ||
  /<!-- (?:issue-pool-source:[0-9a-f]{64}|posthog-(?:log-uuid|error-issue|error-event|manual-issue):[^<>]+) -->/.test(
    issue.body
  );

const matches = (issue: Issue, signal: Signal) =>
  issue.body.includes(sourceMarker(signal.key)) ||
  signal.legacyMarkers.some((marker) => issue.body.includes(marker));

const needsIssue = (matching: readonly Issue[], signal: Signal) =>
  matching.every(
    (issue) =>
      issue.state === "closed" &&
      issue.closedAt !== null &&
      !(
        signal.source === "vercel" &&
        signal.legacyMarkers.some((marker) => issue.body.includes(marker))
      ) &&
      !issue.body.includes("<!-- posthog-agent:triage-non-actionable -->") &&
      Date.parse(signal.observedAt) > Date.parse(issue.closedAt)
  );

export class IssuePool {
  private readonly database: Database;

  constructor(path: string) {
    this.database = new Database(path, { create: true, strict: true });
    this.database.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS intake (
        source_key TEXT NOT NULL,
        previous_issue INTEGER NOT NULL,
        PRIMARY KEY (source_key, previous_issue)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS assignment (
        issue INTEGER PRIMARY KEY,
        thread_id TEXT,
        reported INTEGER NOT NULL DEFAULT 0
      ) STRICT;
    `);
  }

  close(): void {
    this.database.close();
  }

  reserveIntake(key: string, previousIssue: number): boolean {
    return (
      this.database
        .query("INSERT OR IGNORE INTO intake VALUES (?, ?)")
        .run(key, previousIssue).changes === 1
    );
  }

  reserveAssignment(number: number): boolean {
    return (
      this.database
        .query("INSERT OR IGNORE INTO assignment (issue) VALUES (?)")
        .run(number).changes === 1
    );
  }

  claim(number: number): Claim | null {
    return this.database
      .query<Claim, [number]>(
        "SELECT thread_id AS threadId, reported FROM assignment WHERE issue = ?"
      )
      .get(number);
  }

  record(number: number, threadId: string): void {
    this.database
      .query("UPDATE assignment SET thread_id = ? WHERE issue = ?")
      .run(threadId, number);
  }

  markReported(number: number): void {
    this.database
      .query("UPDATE assignment SET reported = 1 WHERE issue = ?")
      .run(number);
  }
}

export async function runIssuePool({
  pool,
  tracker,
  runner,
  signals,
  apply,
  maxNewIssues,
  maxNewWorkers,
}: {
  pool: IssuePool;
  tracker: IssueTracker;
  runner: WorkerRunner;
  signals: readonly Signal[];
  apply: boolean;
  maxNewIssues: number;
  maxNewWorkers: number;
}): Promise<PassResult> {
  const result: PassResult = {
    filed: [],
    assigned: [],
    pendingIntake: [],
    pendingAssignment: [],
    plannedIntake: [],
    plannedAssignment: [],
  };
  const issues = [...(await tracker.list())];
  const eligible = new Set<number>();
  const seen = new Set<string>();
  let intakeAttempts = 0;
  let assignmentAttempts = 0;
  const ordered = Array.from(signals).sort(
    (left, right) =>
      Number(right.priority === "high") - Number(left.priority === "high") ||
      left.observedAt.localeCompare(right.observedAt) ||
      left.key.localeCompare(right.key)
  );

  for (const signal of ordered) {
    if (seen.has(signal.key)) {
      continue;
    }
    seen.add(signal.key);
    const matching = issues.filter((issue) => matches(issue, signal));
    for (const issue of matching) {
      eligible.add(issue.number);
    }
    if (!needsIssue(matching, signal)) {
      continue;
    }
    result.plannedIntake.push(signal.key);
    if (!apply || intakeAttempts >= maxNewIssues) {
      continue;
    }
    const previousIssue = Math.max(0, ...matching.map((issue) => issue.number));
    if (!pool.reserveIntake(signal.key, previousIssue)) {
      result.pendingIntake.push(signal.key);
      continue;
    }
    try {
      intakeAttempts++;
      const issue = await tracker.file(
        signal.title,
        [
          signal.evidence,
          sourceMarker(signal.key),
          ...signal.legacyMarkers.slice(-20),
        ].join("\n\n")
      );
      issues.push(issue);
      eligible.add(issue.number);
      result.filed.push(issue.number);
    } catch {
      result.pendingIntake.push(signal.key);
    }
  }

  const orderedIssues = issues.toSorted(
    (left, right) => left.number - right.number
  );
  for (const issue of orderedIssues) {
    if (issue.state !== "open" || issue.assignees.length > 0) {
      continue;
    }
    if (!ownedByPool(issue) && !eligible.has(issue.number)) {
      continue;
    }
    assignmentAttempts += await assignIssue({
      apply,
      issue,
      allowLaunch: assignmentAttempts < maxNewWorkers,
      pool,
      result,
      runner,
      tracker,
    });
  }
  return result;
}

async function assignIssue({
  apply,
  issue,
  allowLaunch,
  pool,
  result,
  runner,
  tracker,
}: {
  apply: boolean;
  issue: Issue;
  allowLaunch: boolean;
  pool: IssuePool;
  result: PassResult;
  runner: WorkerRunner;
  tracker: IssueTracker;
}): Promise<0 | 1> {
  const number = issue.number;
  const claim = pool.claim(number);
  let launchAttempt: 0 | 1 = 0;
  try {
    if (claim?.reported || (await tracker.hasOwner(number))) {
      return 0;
    }
    result.plannedAssignment.push(number);
    if (!apply) {
      return 0;
    }
    let thread = claim?.threadId ?? (await runner.find(number));
    if (!thread) {
      if (!allowLaunch) {
        return 0;
      }
      if (!pool.reserveAssignment(number)) {
        result.pendingAssignment.push(number);
        return 0;
      }
      launchAttempt = 1;
      thread = await runner.start(number);
    } else {
      pool.reserveAssignment(number);
    }
    pool.record(number, thread);
    await tracker.recordWorker(number, thread);
    pool.markReported(number);
    result.assigned.push(number);
  } catch {
    result.pendingAssignment.push(number);
  }
  return launchAttempt;
}
