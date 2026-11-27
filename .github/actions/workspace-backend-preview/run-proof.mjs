import { createHash } from "node:crypto";

const repositoryId = 1015951989;
const ownerId = 361691508;
const workflowPath = /^\.github\/workflows\/workspace-e2e\.yml(?:@(?:refs\/heads\/)?main)?$/;
const integer = /^[1-9][0-9]{0,14}$/;
const hex32 = /^[0-9a-f]{32}$/;
const hex40 = /^[0-9a-f]{40}$/;
const hex64 = /^[0-9a-f]{64}$/;

const digest = (values) =>
  createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 32);

export function pilotTargetKey(pr, sha, originDigest) {
  if (!integer.test(pr) || !hex40.test(sha) || !hex64.test(originDigest)) {
    throw new Error("Invalid Workspace preview proof target");
  }
  return digest([String(pr), sha, originDigest]);
}

export function pilotGenerationKey(deploymentId, revision, generation) {
  if (
    !/^dpl_[a-zA-Z0-9]+$/.test(deploymentId) ||
    !/^workspace-api-preview-g-[0-9a-f]{16}$/.test(revision) ||
    !hex64.test(generation)
  ) {
    throw new Error("Invalid Workspace preview proof generation");
  }
  return digest([deploymentId, revision, generation]);
}

export function verifyPilotRun({ targetUrl, target, generation, currentRun, read }) {
  const runUrl = /^https:\/\/github\.com\/Deskohub\/deskohub-site\/actions\/runs\/([1-9][0-9]{0,14})\/attempts\/([1-9][0-9]{0,14})$/.exec(targetUrl ?? "");
  if (!runUrl || !hex32.test(target) || !hex32.test(generation)) return false;

  const [, runId, attempt] = runUrl;
  const path = `repos/Deskohub/deskohub-site/actions/runs/${runId}`;
  const run = read(path);
  const finished = run?.status === "completed" && run.conclusion === "success";
  const finishing =
    currentRun === targetUrl && run?.status === "in_progress" && run.conclusion === null;
  if (
    String(run?.id) !== runId ||
    String(run.run_attempt) !== attempt ||
    run.repository?.id !== repositoryId ||
    run.repository?.owner?.id !== ownerId ||
    run.head_repository?.id !== repositoryId ||
    run.head_branch !== "main" ||
    !hex40.test(run.head_sha) ||
    !workflowPath.test(run.path) ||
    !["workflow_dispatch", "repository_dispatch"].includes(run.event) ||
    (!finished && !finishing)
  ) return false;

  const { jobs } = read(`${path}/attempts/${attempt}/jobs?per_page=100`) ?? {};
  if (!Array.isArray(jobs)) return false;
  const name = `Confirm Workspace preview ${target}.${generation}`;
  const matches = jobs.filter((job) => job?.name === name);
  const [job] = matches;
  return matches.length === 1 &&
    String(job.run_id) === runId &&
    job.head_sha === run.head_sha &&
    job.status === "completed" &&
    job.conclusion === "success";
}
