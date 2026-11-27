import assert from "node:assert/strict";
import test from "node:test";
import {
  backendRevisionHeader,
  cloudRunRevisionHeader,
  previewBackendBranchTag,
  previewDatabaseEndpoint,
  previewGenerationHeader,
  previewRuntimeGeneration,
} from "../../../packages/workspace-cloud-run/src/preview-identity.mjs";
import { checkPreviewBinding } from "./e2e-gate.mjs";

const input = {
  origin: "https://deskohub-workspace-site-abcdef123-synthetic.vercel.app",
  sha: "b".repeat(40),
  ref: "test/pilot",
  deploymentId: "dpl_synthetic",
  revision: "workspace-api-preview-g-abcdef1234567890",
  databaseUrl: "postgresql://ep-synthetic.eu-central-1.aws.neon.tech/neondb",
  bypass: "synthetic-bypass",
};
const expected = previewRuntimeGeneration({
  commitSha: input.sha,
  deploymentId: input.deploymentId,
  branchTag: previewBackendBranchTag(input.ref),
  databaseEndpoint: previewDatabaseEndpoint(input.databaseUrl),
});

const proof = ({ commitSha = input.sha, generation = expected, workerTag = "g-abcdef1234567890" } = {}) =>
  Response.json({ commitSha, generation, workerTag, cloudRunRevision: input.revision }, {
    headers: {
      [backendRevisionHeader]: commitSha,
      [cloudRunRevisionHeader]: input.revision,
      [previewGenerationHeader]: generation,
    },
  });

test("checks the exact protected preview without following a redirect", async () => {
  assert.equal(await checkPreviewBinding(input, async (url, options) => {
    assert.equal(url.origin, input.origin);
    assert.equal(url.pathname, "/api/internal/backend-preview");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers["x-vercel-protection-bypass"], input.bypass);
    return proof();
  }), input.revision);
});

test("rejects an A revision, a different database, or another worker in B", async () => {
  await assert.rejects(checkPreviewBinding(input, async () => proof({ commitSha: "a".repeat(40) })), /generation changed/);
  await assert.rejects(checkPreviewBinding(input, async () => proof({ generation: "a".repeat(64) })), /generation changed/);
  await assert.rejects(checkPreviewBinding(input, async () => proof({ workerTag: "g-1111111111111111" })), /generation changed/);
});

test("rejects a different Vercel deployment, branch, or ready revision at the same SHA", async () => {
  for (const change of [
    { deploymentId: "dpl_other" },
    { ref: "test/other" },
    { revision: "workspace-api-preview-g-1111111111111111" },
  ]) {
    await assert.rejects(
      checkPreviewBinding({ ...input, ...change }, async () => proof()),
      /generation changed/
    );
  }
});

test("only the gate outside the lease retries a missing generation", async () => {
  const unavailable = async () => new Response("Unavailable", { status: 503 });
  assert.equal(await checkPreviewBinding({ ...input, databaseUrl: undefined }, unavailable), undefined);
  await assert.rejects(checkPreviewBinding(input, unavailable), /no available backend/);
  await assert.rejects(checkPreviewBinding({ ...input, origin: "https://different.test" }, async () => {
    assert.fail("A foreign origin received the bypass secret");
  }), /protected exact-SHA preview/);
});
