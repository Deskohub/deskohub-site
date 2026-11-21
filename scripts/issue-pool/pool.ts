import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { feedbackCommentIds } from "./feedback";
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
  legacyFeedbackClaimed(commentId: string): boolean;
  suppressesRecurrence(number: number): Promise<boolean>;
  pendingReply(number: number): Promise<WorkerReply | null>;
  recordReply(number: number, commentId: number): Promise<void>;
}

export interface WorkerReply {
  commentId: number;
  threadId: string;
  message: string;
}

export interface WorkerRunner {
  find(number: number): Promise<string | null>;
  start(number: number): Promise<string>;
  sendReply(reply: WorkerReply): Promise<void>;
  receivedReply(reply: WorkerReply): Promise<boolean>;
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
  replied: number[];
  pendingReply: number[];
  plannedReply: number[];
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
  (signal.source === "vercel"
    ? feedbackCommentIds(issue.body).has(signal.commentId)
    : signal.legacyMarkers.some((marker) => issue.body.includes(marker)));

async function needsIssue(
  matching: readonly Issue[],
  signal: Signal,
  tracker: IssueTracker
) {
  if (signal.source === "vercel") {
    return (
      matching.length === 0 && !tracker.legacyFeedbackClaimed(signal.commentId)
    );
  }
  for (const issue of matching) {
    if (
      issue.state !== "closed" ||
      issue.closedAt === null ||
      Date.parse(signal.observedAt) <= Date.parse(issue.closedAt) ||
      issue.body.includes("<!-- posthog-agent:triage-non-actionable -->") ||
      (await tracker.suppressesRecurrence(issue.number))
    ) {
      return false;
    }
  }
  return true;
}

export class IssuePool {
  private readonly database: Database;

  constructor(path: string, readonly = false) {
    this.database = new Database(path, {
      readonly,
      create: !readonly,
      strict: true,
    });
    this.database.exec("PRAGMA busy_timeout = 5000");
    if (!readonly)
      this.database.exec(`
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
      CREATE TABLE IF NOT EXISTS source_issue (
        source_key TEXT NOT NULL,
        issue INTEGER NOT NULL,
        PRIMARY KEY (source_key, issue)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS worker_reply (
        comment_id INTEGER PRIMARY KEY,
        accepted INTEGER NOT NULL DEFAULT 0
      ) STRICT;
    `);
  }

  close(): void {
    this.database.close();
  }

  linkedIssues(key: string): ReadonlySet<number> {
    return new Set(
      this.database
        .query<{ issue: number }, [string]>(
          "SELECT issue FROM source_issue WHERE source_key = ?"
        )
        .all(key)
        .map(({ issue }) => issue)
    );
  }

  linkIssue(key: string, number: number): void {
    this.database
      .query("INSERT OR IGNORE INTO source_issue VALUES (?, ?)")
      .run(key, number);
  }

  reserveReply(commentId: number): boolean {
    return (
      this.database
        .query("INSERT OR IGNORE INTO worker_reply (comment_id) VALUES (?)")
        .run(commentId).changes === 1
    );
  }

  replyAccepted(commentId: number): boolean {
    return (
      this.database
        .query<{ accepted: number }, [number]>(
          "SELECT accepted FROM worker_reply WHERE comment_id = ?"
        )
        .get(commentId)?.accepted === 1
    );
  }

  acceptReply(commentId: number): void {
    this.database
      .query("UPDATE worker_reply SET accepted = 1 WHERE comment_id = ?")
      .run(commentId);
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
    replied: [],
    pendingReply: [],
    plannedReply: [],
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
    const linked = pool.linkedIssues(signal.key);
    const matching = issues.filter(
      (issue) => linked.has(issue.number) || matches(issue, signal)
    );
    for (const issue of matching) {
      eligible.add(issue.number);
      if (apply) pool.linkIssue(signal.key, issue.number);
    }
    try {
      if (!(await needsIssue(matching, signal, tracker))) {
        continue;
      }
      result.plannedIntake.push(signal.key);
      if (!apply || intakeAttempts >= maxNewIssues) {
        continue;
      }
      const previousIssue = Math.max(
        0,
        ...matching.map((issue) => issue.number)
      );
      if (!pool.reserveIntake(signal.key, previousIssue)) {
        result.pendingIntake.push(signal.key);
        continue;
      }
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
      pool.linkIssue(signal.key, issue.number);
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
    if (issue.state !== "open") {
      continue;
    }
    if (!ownedByPool(issue) && !eligible.has(issue.number)) {
      continue;
    }
    await reconcileReply({
      apply,
      number: issue.number,
      pool,
      result,
      runner,
      tracker,
    });
    if (issue.assignees.length > 0) {
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

async function reconcileReply({
  apply,
  number,
  pool,
  result,
  runner,
  tracker,
}: {
  apply: boolean;
  number: number;
  pool: IssuePool;
  result: PassResult;
  runner: WorkerRunner;
  tracker: IssueTracker;
}): Promise<void> {
  try {
    const reply = await tracker.pendingReply(number);
    if (!reply) return;
    result.plannedReply.push(number);
    if (!apply) return;
    if (pool.reserveReply(reply.commentId)) {
      await runner.sendReply(reply);
      pool.acceptReply(reply.commentId);
    } else if (!pool.replyAccepted(reply.commentId)) {
      if (!(await runner.receivedReply(reply))) {
        result.pendingReply.push(number);
        return;
      }
      pool.acceptReply(reply.commentId);
    }
    await tracker.recordReply(number, reply.commentId);
    result.replied.push(number);
  } catch {
    result.pendingReply.push(number);
  }
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
