import { feedbackCommentIds } from "./feedback";
import type { Issue, IssueTracker } from "./pool";

export type Command = (
  executable: string,
  args: readonly string[],
  input?: string
) => Promise<string>;

interface RestIssue {
  number: number;
  state: "open" | "closed";
  closed_at: string | null;
  body: string | null;
  assignees: { login: string }[];
  labels: { name: string }[];
  user: { login: string } | null;
  pull_request?: object;
}

interface IssueComment {
  id: number;
  body: string | null;
  user: { login: string } | null;
}

const threadMarker = /<!-- t3-worker-thread:([a-zA-Z0-9:%_-]+) -->/;
const humanNeeded = "<!-- posthog-agent:human-needed -->";
const consumed = (commentId: number) =>
  `<!-- posthog-agent:consumed-comment:${commentId} -->`;

const issueFromRest = (
  issue: RestIssue,
  trusted: ReadonlySet<string>
): Issue => ({
  number: issue.number,
  state: issue.state,
  closedAt: issue.closed_at,
  body:
    issue.user && trusted.has(issue.user.login.toLowerCase())
      ? (issue.body ?? "")
      : "",
  labels: issue.labels.map((label) => label.name),
  assignees: issue.assignees.map((assignee) => assignee.login),
});

interface IssueOwnership {
  repository: {
    issue: {
      state: "OPEN" | "CLOSED";
      body: string;
      author: { login: string } | null;
      assignees: { totalCount: number };
      closedByPullRequestsReferences: { nodes: { state: string }[] };
    } | null;
  } | null;
}

const ownershipQuery = `query ($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      state
      body
      author { login }
      assignees(first: 1) { totalCount }
      closedByPullRequestsReferences(first: 100) { nodes { state } }
    }
  }
}`;

export function githubIssueTracker({
  repo,
  run,
  trustedReporters,
  legacyFeedbackClaimed,
}: {
  repo: string;
  run: Command;
  trustedReporters: readonly string[];
  legacyFeedbackClaimed: (commentId: string) => boolean;
}): IssueTracker {
  const [owner = "", name = ""] = repo.split("/");
  const base = `repos/${repo}/issues`;
  const trusted = new Set(trustedReporters.map((login) => login.toLowerCase()));
  const getPages = async <T>(path: string): Promise<T[]> => {
    const response = await run("gh", ["api", "--paginate", "--slurp", path]);
    const pages: T[][] = JSON.parse(response);
    return pages.flat();
  };
  const comments = new Map<number, Promise<IssueComment[]>>();
  function issueComments(number: number): Promise<IssueComment[]> {
    let cached = comments.get(number);
    if (!cached) {
      cached = getPages<IssueComment>(
        `${base}/${number}/comments?per_page=100`
      ).then((rows) =>
        rows
          .filter(({ user }) => user && trusted.has(user.login.toLowerCase()))
          .sort((left, right) => left.id - right.id)
      );
      comments.set(number, cached);
    }
    return cached;
  }
  const workerRecorded = async (number: number) =>
    (await issueComments(number)).some(({ body }) =>
      threadMarker.test(body ?? "")
    );
  async function postComment(number: number, body: string): Promise<void> {
    await run(
      "gh",
      ["api", "--method", "POST", `${base}/${number}/comments`, "--input", "-"],
      JSON.stringify({ body })
    );
    comments.delete(number);
  }
  async function readOwnership(number: number) {
    const response = await run("gh", [
      "api",
      "graphql",
      "-f",
      `query=${ownershipQuery}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
      "-F",
      `number=${number}`,
    ]);
    const { data }: { data: IssueOwnership } = JSON.parse(response);
    return data.repository?.issue;
  }
  return {
    async list() {
      const issues = await getPages<RestIssue>(
        `${base}?state=all&per_page=100`
      );
      return issues
        .filter((issue) => !issue.pull_request)
        .map((issue) => issueFromRest(issue, trusted));
    },
    async file(title, body) {
      const response = await run(
        "gh",
        ["api", "--method", "POST", base, "--input", "-"],
        JSON.stringify({ title, body })
      );
      const issue: RestIssue = JSON.parse(response);
      const created = issueFromRest(issue, trusted);
      if (created.body !== body) {
        throw new Error("Created issue did not retain the pool source marker");
      }
      return created;
    },
    async hasOwner(number) {
      const issue = await readOwnership(number);
      return (
        issue?.state !== "OPEN" ||
        issue.assignees.totalCount > 0 ||
        issue.closedByPullRequestsReferences.nodes.some(
          (pr) => pr.state === "OPEN"
        ) ||
        (await workerRecorded(number)) ||
        (issue.author !== null &&
          trusted.has(issue.author.login.toLowerCase()) &&
          Array.from(feedbackCommentIds(issue.body)).some(
            legacyFeedbackClaimed
          ))
      );
    },
    async recordWorker(number, threadId) {
      if (!/^[a-zA-Z0-9:%_-]+$/.test(threadId)) {
        throw new Error("Unexpected T3 thread identifier");
      }
      if (await workerRecorded(number)) {
        return;
      }
      await postComment(
        number,
        `Assigned to T3 worker \`${threadId}\`.\n\n<!-- t3-worker-thread:${threadId} -->`
      );
    },
    legacyFeedbackClaimed,
    async suppressesRecurrence(number) {
      return (await issueComments(number)).some(({ body }) =>
        body?.includes("<!-- posthog-agent:triage-non-actionable -->")
      );
    },
    async pendingReply(number) {
      const rows = await issueComments(number);
      const question = rows.findLast(({ body }) => body?.includes(humanNeeded));
      const worker = rows.findLast(({ body }) => threadMarker.test(body ?? ""));
      const threadId = worker?.body?.match(threadMarker)?.[1];
      if (!question || !threadId) return null;
      const reply = rows.find(
        ({ id, body, user }) =>
          id > question.id &&
          user?.login.toLowerCase() === "totalolage" &&
          body?.trim() &&
          !/<!-- (?:posthog-agent:|t3-worker-thread:)/.test(body) &&
          !rows.some(({ body: comment }) => comment?.includes(consumed(id)))
      );
      if (!reply?.body || (await readOwnership(number))?.state !== "OPEN")
        return null;
      return { commentId: reply.id, threadId, message: reply.body };
    },
    async recordReply(number, commentId) {
      if (
        !(await issueComments(number)).some(({ body }) =>
          body?.includes(consumed(commentId))
        )
      ) {
        await postComment(number, consumed(commentId));
      }
    },
  };
}
