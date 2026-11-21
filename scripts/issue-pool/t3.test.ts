import { expect, test } from "bun:test";
import { t3WorkerRunner } from "./t3";

test("adopts only a worker bound to the issue branch or a prior PostHog worker ID", async () => {
  const runner = t3WorkerRunner({
    repo: "owner/repository",
    project: "project-id",
    executable: "t3",
    async run(_command, args) {
      if (args.includes("list")) {
        return JSON.stringify([
          { title: "Deskohub issue #32", threadId: "irrelevant-thread" },
          { title: "Deskohub issue #32", threadId: "actual-worker" },
          { title: "Existing incident", threadId: "posthog-worker-issue-33" },
        ]);
      }
      const threadId = args.at(-1);
      const branch =
        threadId === "actual-worker" ? "issue-pool/issue-32" : "main";
      return JSON.stringify({ thread: { threadId, branch } });
    },
  });
  expect(await runner.find(32)).toBe("actual-worker");
  expect(await runner.find(33)).toBe("posthog-worker-issue-33");
  expect(await runner.find(34)).toBeNull();
});

test("queues the issue in its own T3 worktree and sends only its trusted brief", async () => {
  const runner = t3WorkerRunner({
    repo: "owner/repository",
    project: "project-id",
    executable: "t3",
    async run(command, args, stdin) {
      expect(command).toBe("t3");
      expect(args.slice(0, 2)).toEqual(["thread", "start"]);
      expect(args).toContain("origin/main");
      expect(args).toContain("issue-pool/issue-32");
      expect(stdin).toContain("https://github.com/owner/repository/issues/32");
      return JSON.stringify({ threadId: "worker-id" });
    },
  });
  expect(await runner.start(32)).toBe("worker-id");
});
