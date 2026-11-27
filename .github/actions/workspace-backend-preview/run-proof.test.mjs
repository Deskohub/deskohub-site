import assert from "node:assert/strict";
import test from "node:test";
import { pilotGenerationKey, pilotTargetKey, verifyPilotRun } from "./run-proof.mjs";

const runUrl = "https://github.com/Deskohub/deskohub-site/actions/runs/42/attempts/2";
const runPath = "repos/Deskohub/deskohub-site/actions/runs/42";
const sha = "a".repeat(40);
const originDigest = "b".repeat(64);
const target = pilotTargetKey("8", sha, originDigest);
const generation = pilotGenerationKey("dpl_previewB", "workspace-api-preview-g-1234567890123456", "c".repeat(64));
const run = {
  id: 42,
  run_attempt: 2,
  repository: { id: 1015951989, owner: { id: 361691508 } },
  head_repository: { id: 1015951989 },
  head_branch: "main",
  head_sha: "d".repeat(40),
  path: ".github/workflows/workspace-e2e.yml@main",
  event: "repository_dispatch",
  status: "completed",
  conclusion: "success",
};
const job = {
  run_id: run.id,
  head_sha: run.head_sha,
  name: `Confirm Workspace preview ${target}.${generation}`,
  status: "completed",
  conclusion: "success",
};
const fixture = (changedRun = run, jobs = [job]) => ({
  targetUrl: runUrl,
  target,
  generation,
  read(path) {
    if (path === runPath) return changedRun;
    assert.equal(path, `${runPath}/attempts/2/jobs?per_page=100`);
    return { jobs };
  },
});

test("requires a successful matching job from the current attempt on the reviewed main workflow", () => {
  assert.equal(verifyPilotRun(fixture()), true);
  for (const invalid of [
    { run_attempt: 3 },
    { head_branch: "feat/pilot" },
    { event: "pull_request_target" },
    { path: ".github/workflows/other.yml@main" },
    { path: ".github/workflows/workspace-e2e.yml@feat/pilot" },
    { repository: { ...run.repository, owner: { id: 1 } } },
    { head_repository: { id: 17 } },
    { conclusion: "failure" },
  ]) {
    assert.equal(verifyPilotRun(fixture({ ...run, ...invalid })), false);
  }
  for (const invalid of [
    [],
    [job, job],
    [{ ...job, run_id: 17 }],
    [{ ...job, head_sha: sha }],
    [{ ...job, conclusion: "skipped" }],
  ]) {
    assert.equal(verifyPilotRun(fixture(run, invalid)), false);
  }
});

test("rejects a status replay from a different PR, SHA, immutable deployment, or backend generation", () => {
  for (const key of [
    pilotTargetKey("17", sha, originDigest),
    pilotTargetKey("8", "0".repeat(40), originDigest),
    pilotTargetKey("8", sha, "0".repeat(64)),
  ]) {
    assert.equal(verifyPilotRun({ ...fixture(), target: key }), false);
  }
  assert.equal(verifyPilotRun({ ...fixture(), generation: pilotGenerationKey("dpl_previewA", "workspace-api-preview-g-1111111111111111", "f".repeat(64)) }), false);
  assert.equal(verifyPilotRun({ ...fixture(), targetUrl: runUrl.split("/attempts")[0] }), false);
});

test("only the current trusted final publisher can read an in-progress run", () => {
  const active = fixture({ ...run, event: "workflow_dispatch", status: "in_progress", conclusion: null });
  assert.equal(verifyPilotRun(active), false);
  assert.equal(verifyPilotRun({ ...active, currentRun: runUrl }), true);
  assert.equal(verifyPilotRun({ ...active, currentRun: `${runUrl}0` }), false);
});
