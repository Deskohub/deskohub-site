import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { backendGenerationRequired } from "./paths.mjs";

const repository = "Deskohub/deskohub-site";
const repositoryId = 1015951989;
const ownerId = 361691508;
const main = "refs/heads/main";
const workflowPath = ".github/workflows/workspace-backend-preview.yml";
const teamId = "team_MgMQ4MEWijWnYa1R48C2JU5e";
const projectId = "prj_7FliQBcbBiBwGaO2JLrigicnXCRd";
const deploymentEnvironment = "Preview – deskohub-workspace-site";

const shaPattern = /^[0-9a-f]{40}$/;
const prNumberPattern = /^[1-9][0-9]{0,8}$/;
const deploymentPattern = /^dpl_[A-Za-z0-9]{1,64}$/;
const branchIdPattern = /^br-[a-z0-9-]{1,70}$/;
const branchRefPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const projectIdPattern = /^[a-z][a-z0-9-]{0,98}[a-z0-9]$/;
const protectionScopes = new Set([
  "all",
  "all_except_custom_domains",
  "preview",
  "prod_deployment_urls_and_all_previews",
]);

class PreviewError extends Error {}

function requireCondition(condition, message) {
  if (!condition) throw new PreviewError(message);
}

export function dispatchTarget(env) {
  requireCondition(
    env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
      env.GITHUB_REPOSITORY?.toLowerCase() === repository.toLowerCase() &&
      env.GITHUB_REPOSITORY_ID === String(repositoryId) &&
      env.GITHUB_REPOSITORY_OWNER_ID === String(ownerId) &&
      env.GITHUB_REF === main &&
      env.GITHUB_REF_PROTECTED === "true" &&
      env.GITHUB_WORKFLOW_REF === `${repository}/${workflowPath}@${main}` &&
      shaPattern.test(env.GITHUB_WORKFLOW_SHA) &&
      env.GITHUB_WORKFLOW_SHA === env.GITHUB_SHA,
    "Expected the reviewed preview workflow on protected main.",
  );
  const { PREVIEW_OPERATION, PR_NUMBER, GIT_SHA, VERCEL_DEPLOYMENT_ID } = env;
  requireCondition(
    PREVIEW_OPERATION === "deploy" || PREVIEW_OPERATION === "cleanup",
    "Unknown preview operation.",
  );
  requireCondition(
    prNumberPattern.test(PR_NUMBER) && PR_NUMBER === env.PILOT_PR_NUMBER,
    "The pull request must match the configured pilot.",
  );
  requireCondition(
    shaPattern.test(GIT_SHA),
    "Expected a full lowercase head SHA.",
  );
  requireCondition(
    PREVIEW_OPERATION === "deploy"
      ? deploymentPattern.test(VERCEL_DEPLOYMENT_ID)
      : VERCEL_DEPLOYMENT_ID === "",
    "Deploy needs a Vercel deployment ID. Cleanup leaves it empty.",
  );
  return {
    operation: PREVIEW_OPERATION,
    number: Number(PR_NUMBER),
    sha: GIT_SHA,
    deploymentId: VERCEL_DEPLOYMENT_ID,
  };
}

function canonicalRef(ref) {
  return (
    typeof ref === "string" &&
    branchRefPattern.test(ref) &&
    spawnSync("git", ["check-ref-format", `refs/heads/${ref}`], {
      stdio: "ignore",
    }).status === 0
  );
}

function fromRepository(repo) {
  return repo?.id === repositoryId && repo.owner?.id === ownerId;
}

function github(path, token, request) {
  return request(`https://api.github.com/repos/${repository}/${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
}

async function readJson(response, provider) {
  requireCondition(
    response.ok,
    `${provider} did not return the expected record.`,
  );
  return response.json();
}

export async function pullRequestTarget(
  target,
  env,
  request = fetch,
  checkPaths = false,
) {
  requireCondition(env.GH_TOKEN, "GitHub token is missing.");
  const pull = `pulls/${target.number}`;
  const get = async (path) =>
    readJson(await github(path, env.GH_TOKEN, request), "GitHub");
  const readPull = async () => {
    const pr = await get(pull);
    requireCondition(
      pr.number === target.number &&
        pr.state === (target.operation === "deploy" ? "open" : "closed") &&
        (target.operation === "cleanup" || pr.draft === false) &&
        pr.user?.type === "User" &&
        typeof pr.user.login === "string" &&
        !pr.user.login.toLowerCase().endsWith("[bot]") &&
        fromRepository(pr.base?.repo) &&
        pr.base.ref === "main" &&
        fromRepository(pr.head?.repo) &&
        pr.head.sha === target.sha &&
        pr.head.ref !== "main" &&
        canonicalRef(pr.head.ref) &&
        (env.GIT_REF === undefined || env.GIT_REF === pr.head.ref),
      "Expected an eligible internal pilot pull request at its requested head.",
    );
    return pr;
  };

  const pr = await readPull();
  if (checkPaths && target.operation === "deploy") {
    requireCondition(
      Number.isInteger(pr.changed_files) &&
        pr.changed_files > 0 &&
        pr.changed_files <= 3000,
      "GitHub cannot return the complete pull request file list.",
    );
    const paths = [];
    const seen = new Set();
    for (let start = 0; start < pr.changed_files; start += 100) {
      const page = await get(
        `${pull}/files?per_page=100&page=${start / 100 + 1}`,
      );
      requireCondition(
        Array.isArray(page) &&
          page.length === Math.min(100, pr.changed_files - start),
        "GitHub returned an incomplete pull request file list.",
      );
      for (const file of page) {
        requireCondition(
          typeof file.filename === "string" &&
            file.filename.length > 0 &&
            !seen.has(file.filename),
          "GitHub returned an invalid pull request file list.",
        );
        seen.add(file.filename);
        paths.push(file.filename);
        if (file.status === "renamed") {
          requireCondition(
            typeof file.previous_filename === "string" &&
              file.previous_filename.length > 0,
            "GitHub omitted a renamed pull request path.",
          );
          paths.push(file.previous_filename);
        }
      }
    }
    const current = await readPull();
    requireCondition(
      current.head.ref === pr.head.ref &&
        current.base.sha === pr.base.sha &&
        current.changed_files === pr.changed_files,
      "The pull request changed while its file list was being checked.",
    );
    requireCondition(
      backendGenerationRequired(paths),
      "This pull request has no backend changes.",
    );
  }

  // A closed pull request can outlive its Git branch. Cleanup fences on the
  // closed PR's final head and the generation the deploy CLI recorded.
  if (target.operation === "deploy") {
    const ref = pr.head.ref.split("/").map(encodeURIComponent).join("/");
    const branch = await get(`git/ref/heads/${ref}`);
    requireCondition(
      branch.ref === `refs/heads/${pr.head.ref}` &&
        branch.object?.type === "commit" &&
        branch.object.sha === target.sha,
      "The Git branch no longer matches the requested head.",
    );
  }
  return pr.head.ref;
}

function vercel(path, token, request) {
  const url = new URL(path, "https://api.vercel.com");
  url.searchParams.set("teamId", teamId);
  return request(url, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
}

export async function verifyVercel(target, env, request = fetch) {
  requireCondition(
    env.VERCEL_TOKEN && env.GH_TOKEN,
    "Preview metadata credentials are missing.",
  );
  const [deployment, project] = await Promise.all([
    vercel(
      `/v13/deployments/${target.deploymentId}?withGitRepoInfo=true`,
      env.VERCEL_TOKEN,
      request,
    ).then((response) => readJson(response, "Vercel")),
    vercel(`/v9/projects/${projectId}`, env.VERCEL_TOKEN, request).then(
      (response) => readJson(response, "Vercel"),
    ),
  ]);
  requireCondition(
    deployment.id === target.deploymentId &&
      deployment.projectId === projectId &&
      deployment.ownerId === teamId &&
      deployment.target === null &&
      deployment.public === false &&
      !deployment.customEnvironment &&
      deployment.readyState === "READY" &&
      deployment.gitSource?.type === "github" &&
      String(deployment.gitSource.repoId) === String(repositoryId) &&
      deployment.gitSource.ref === env.GIT_REF &&
      deployment.gitSource.sha === target.sha &&
      typeof deployment.url === "string" &&
      /^[a-z0-9-]+\.vercel\.app$/.test(deployment.url) &&
      !deployment.url.includes("-git-"),
    "Vercel did not return the exact READY Git preview deployment.",
  );
  requireCondition(
    project.id === projectId &&
      project.accountId === teamId &&
      protectionScopes.has(project.ssoProtection?.deploymentType),
    "Vercel Authentication must protect Workspace previews.",
  );

  const origin = `https://${deployment.url}`;
  const aliasResponse = await vercel(
    `/v4/aliases/${deployment.url}`,
    env.VERCEL_TOKEN,
    request,
  );
  if (aliasResponse.status !== 404) {
    const alias = await readJson(aliasResponse, "Vercel");
    requireCondition(
      alias.alias === deployment.url &&
        alias.deploymentId === deployment.id &&
        !Object.values(alias.protectionBypass ?? {}).some(
          (entry) => entry?.scope === "alias-protection-override",
        ),
      "Vercel reports a protection exception or a different target for the preview URL.",
    );
  }
  const query = new URLSearchParams({
    sha: target.sha,
    environment: deploymentEnvironment,
    per_page: "100",
  });
  const records = await readJson(
    await github(`deployments?${query}`, env.GH_TOKEN, request),
    "GitHub",
  );
  requireCondition(
    Array.isArray(records),
    "GitHub did not return the preview deployment list.",
  );
  let recorded = false;
  for (const record of records) {
    if (
      record.creator?.login !== "vercel[bot]" ||
      record.sha !== target.sha ||
      record.environment !== deploymentEnvironment ||
      !Number.isSafeInteger(record.id)
    )
      continue;
    const statuses = await readJson(
      await github(
        `deployments/${record.id}/statuses?per_page=100`,
        env.GH_TOKEN,
        request,
      ),
      "GitHub",
    );
    recorded =
      Array.isArray(statuses) &&
      statuses.some(
        (status) =>
          status.creator?.login === "vercel[bot]" &&
          status.state === "success" &&
          [origin, `${origin}/`].includes(status.environment_url),
      );
    if (recorded) break;
  }
  requireCondition(
    recorded,
    "The exact Vercel preview has no successful GitHub deployment record.",
  );

  // Project settings do not rule out an exception for an individual host.
  // Probe without credentials and never follow a deployment response redirect.
  const probe = await request(`${origin}/`, {
    method: "HEAD",
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  requireCondition(
    probe.status === 401,
    "The immutable preview did not require authentication.",
  );
}

function neon(path, token, request) {
  return request(`https://console.neon.tech/api/v2/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  }).then((response) => readJson(response, "Neon"));
}

export async function verifyNeon(env, request = fetch) {
  const { NEON_PROJECT_ID, NEON_API_KEY, APPROVED_NEON_BRANCH_ID } = env;
  requireCondition(
    NEON_PROJECT_ID &&
      projectIdPattern.test(NEON_PROJECT_ID) &&
      branchIdPattern.test(APPROVED_NEON_BRANCH_ID) &&
      NEON_API_KEY,
    "An approved Neon project, branch, and preview credential are required.",
  );
  const project = `projects/${NEON_PROJECT_ID}`;
  const { branch } = await neon(
    `${project}/branches/${APPROVED_NEON_BRANCH_ID}`,
    NEON_API_KEY,
    request,
  );
  requireCondition(
    branch?.id === APPROVED_NEON_BRANCH_ID &&
      branch.name === `preview/${env.GIT_REF}` &&
      branch.default === false &&
      branch.primary !== true &&
      branchIdPattern.test(branch.parent_id),
    "Neon did not return the approved non-default preview branch.",
  );
  return branch.id;
}

export async function pooledNeonUrl(env, request = fetch) {
  const branchId = await verifyNeon(env, request);
  const query = new URLSearchParams({
    branch_id: branchId,
    database_name: "neondb",
    role_name: "neondb_owner",
    pooled: "true",
  });
  const { uri } = await neon(
    `projects/${env.NEON_PROJECT_ID}/connection_uri?${query}`,
    env.NEON_API_KEY,
    request,
  );
  requireCondition(
    typeof uri === "string" && !/[\r\n]/.test(uri),
    "Neon returned an invalid pooled connection URI.",
  );
  const url = new URL(uri);
  requireCondition(
    ["postgres:", "postgresql:"].includes(url.protocol) &&
      /^ep-[a-z0-9-]+-pooler\.[a-z0-9.-]+\.neon\.tech$/.test(url.hostname) &&
      url.username === "neondb_owner" &&
      url.password &&
      url.pathname === "/neondb" &&
      url.searchParams.get("sslmode") === "require" &&
      !url.hash,
    "Neon returned an invalid pooled connection URI.",
  );
  return { branchId, uri };
}

async function mainCommand(command, env) {
  const target = dispatchTarget(env);
  switch (command) {
    case "config":
      requireCondition(
        branchIdPattern.test(env.APPROVED_NEON_BRANCH_ID),
        "The pilot Neon branch ID is missing.",
      );
      if (target.operation === "deploy") {
        requireCondition(
          env.NEON_PROJECT_ID &&
            projectIdPattern.test(env.NEON_PROJECT_ID) &&
            /^[1-9][0-9]*$/.test(env.PREVIEW_SIGNING_SECRET_VERSION),
          "The pilot Neon project or signing secret version is missing.",
        );
      }
      break;
    case "resolve": {
      const ref = await pullRequestTarget(target, env, fetch, true);
      appendFileSync(env.GITHUB_OUTPUT, `head_ref=${ref}\n`);
      break;
    }
    case "recheck":
      await pullRequestTarget(target, env);
      break;
    case "vercel":
      await verifyVercel(target, env);
      break;
    case "neon-recheck":
      await verifyNeon(env);
      break;
    case "neon": {
      const { branchId, uri } = await pooledNeonUrl(env);
      console.log(`::add-mask::${branchId}`);
      console.log(`::add-mask::${uri.replaceAll("%", "%25")}`);
      appendFileSync(
        env.GITHUB_OUTPUT,
        `branch_id=${branchId}\ndatabase_url=${uri}\n`,
      );
      break;
    }
    default:
      throw new PreviewError("Unknown preview validation command.");
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await mainCommand(process.argv[2], process.env);
  } catch (error) {
    // HTTP and URL parsing errors can carry a protected origin or credential.
    console.error(
      error instanceof PreviewError
        ? error.message
        : "Preview validation failed.",
    );
    process.exitCode = 1;
  }
}
