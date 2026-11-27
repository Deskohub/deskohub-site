import { appendFile } from "node:fs/promises";
import { classifyPullRequestTarget, verifyVercel } from "./target.mjs";

async function main() {
  const target = {
    operation: "deploy",
    number: Number(process.env.PR_NUMBER),
    sha: process.env.TARGET_SHA,
  };
  const environment = { ...process.env, GIT_REF: process.env.TARGET_REF };
  switch (process.argv[2]) {
    case "classify": {
      const { backendRequired } = await classifyPullRequestTarget(target, environment);
      process.stdout.write(`${backendRequired}\n`);
      return;
    }
    case "deployment": {
      const { deploymentId } = await verifyVercel({
        ...target,
        expectedOrigin: process.env.WORKSPACE_E2E_BASE_URL,
      }, environment);
      if (!process.env.GITHUB_OUTPUT) throw new Error("GitHub outputs are unavailable");
      await appendFile(process.env.GITHUB_OUTPUT, `deployment_id=${deploymentId}\n`);
      return;
    }
    default:
      throw new Error("Unknown backend preview target operation");
  }
}

main().catch(() => {
  process.stderr.write("Could not verify the Workspace backend preview target.\n");
  process.exitCode = 1;
});
