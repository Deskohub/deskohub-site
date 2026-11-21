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
  legacyVercelReported,
}: {
  repo: string;
  run: Command;
  trustedReporters: readonly string[];
  legacyVercelReported: (body: string) => boolean;
}): IssueTracker {
  const [owner = "", name = ""] = repo.split("/");
  const base = `repos/${repo}/issues`;
  const trusted = new Set(trustedReporters.map((login) => login.toLowerCase()));
  const getPages = async <T>(path: string): Promise<T[]> => {
    const response = await run("gh", ["api", "--paginate", "--slurp", path]);
    const pages: T[][] = JSON.parse(response);
    return pages.flat();
  };
  const workerRecorded = async (number: number) =>
    (
      await getPages<{ body: string | null; user: { login: string } | null }>(
        `${base}/${number}/comments?per_page=100`
      )
    ).some(
      ({ body, user }) =>
        user &&
        trusted.has(user.login.toLowerCase()) &&
        body?.includes("<!-- t3-worker-thread:")
    );
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
      const issue = data.repository?.issue;
      return (
        issue?.state !== "OPEN" ||
        issue.assignees.totalCount > 0 ||
        issue.closedByPullRequestsReferences.nodes.some(
          (pr) => pr.state === "OPEN"
        ) ||
        (await workerRecorded(number)) ||
        (issue.author !== null &&
          trusted.has(issue.author.login.toLowerCase()) &&
          legacyVercelReported(issue.body))
      );
    },
    async recordWorker(number, threadId) {
      if (!/^[a-zA-Z0-9:%_-]+$/.test(threadId)) {
        throw new Error("Unexpected T3 thread identifier");
      }
      if (await workerRecorded(number)) {
        return;
      }
      await run(
        "gh",
        [
          "api",
          "--method",
          "POST",
          `${base}/${number}/comments`,
          "--input",
          "-",
        ],
        JSON.stringify({
          body: `Assigned to T3 worker \`${threadId}\`.\n\n<!-- t3-worker-thread:${threadId} -->`,
        })
      );
    },
  };
}
