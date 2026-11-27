import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  backendRevisionHeader,
  cloudRunRevisionHeader,
  previewBackendBranchTag,
  previewDatabaseEndpoint,
  previewGenerationHeader,
  previewRuntimeGeneration,
} from "../../../packages/workspace-cloud-run/src/preview-identity.mjs";

const immutableWorkspaceHost =
  /^deskohub-workspace(?:-site)?-[a-z0-9]{9}-[a-z0-9-]+\.vercel\.app$/;
const apiRevision = /^workspace-api-preview-(g-[0-9a-f]{16})$/;

export async function checkPreviewBinding(input, request = fetch) {
  const origin = URL.parse(input.origin ?? "");
  if (
    !origin ||
    origin.origin !== input.origin ||
    origin.protocol !== "https:" ||
    !immutableWorkspaceHost.test(origin.hostname) ||
    !input.bypass ||
    !/^[0-9a-f]{40}$/.test(input.sha ?? "")
  ) {
    throw new Error("Backend gate requires a protected exact-SHA preview");
  }
  let expectedBinding;
  if (input.databaseUrl !== undefined) {
    const databaseEndpoint = previewDatabaseEndpoint(input.databaseUrl);
    if (!databaseEndpoint || !input.ref || !input.deploymentId || !input.revision) {
      throw new Error("Backend gate is missing the expected preview generation");
    }
    expectedBinding = previewRuntimeGeneration({
      commitSha: input.sha,
      deploymentId: input.deploymentId,
      branchTag: previewBackendBranchTag(input.ref),
      databaseEndpoint,
    });
  }

  const response = await request(new URL("/api/internal/backend-preview", origin), {
    headers: { "x-vercel-protection-bypass": input.bypass },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
  });
  if (response.status === 503 && expectedBinding === undefined) {
    await response.body?.cancel();
    return undefined;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("The exact Workspace preview has no available backend generation");
  }

  const revision = response.headers.get(cloudRunRevisionHeader);
  const generation = response.headers.get(previewGenerationHeader);
  const workerTag = revision && apiRevision.exec(revision)?.[1];
  const proof = await response.json();
  if (
    !workerTag ||
    !generation ||
    !/^[0-9a-f]{64}$/.test(generation) ||
    response.headers.get(backendRevisionHeader) !== input.sha ||
    proof?.commitSha !== input.sha ||
    proof.cloudRunRevision !== revision ||
    proof.generation !== generation ||
    proof.workerTag !== workerTag ||
    (expectedBinding !== undefined && (generation !== expectedBinding || revision !== input.revision))
  ) {
    throw new Error("Workspace preview backend, worker, or Neon generation changed");
  }
  return revision;
}

async function run() {
  const mode = process.argv[2];
  const input = {
    origin: process.env.WORKSPACE_E2E_BASE_URL,
    bypass: process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
    sha: process.env.TARGET_SHA,
    ref: process.env.TARGET_REF,
    deploymentId: process.env.VERCEL_DEPLOYMENT_ID,
    revision: process.env.BACKEND_PREVIEW_REVISION,
    databaseUrl: process.env.BACKEND_PREVIEW_DATABASE_URL,
  };
  if (mode === "verify") {
    if (!input.databaseUrl) throw new Error("A leased preview database is required");
    await checkPreviewBinding(input);
    return;
  }
  if (mode !== "wait" || !process.env.GITHUB_OUTPUT) {
    throw new Error("Invalid preview gate invocation");
  }

  const deadline = Date.now() + 360_000;
  for (;;) {
    const revision = await checkPreviewBinding(input);
    if (revision) {
      await appendFile(process.env.GITHUB_OUTPUT, `revision=${revision}\n`);
      return;
    }
    if (Date.now() >= deadline) throw new Error("The expected backend preview generation timed out");
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(() => {
    process.stderr.write("Workspace backend preview generation verification failed. Verify the approved deployment and retry.\n");
    process.exitCode = 1;
  });
}
