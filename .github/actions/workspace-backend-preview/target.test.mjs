import assert from "node:assert/strict";
import { test } from "node:test";
import { backendGenerationRequired } from "./paths.mjs";
import {
  dispatchTarget,
  pooledNeonUrl,
  pullRequestTarget,
  verifyVercel,
} from "./target.mjs";

const sha = "b".repeat(40);
const ref = "feat/backend-pilot";
const deploymentId = "dpl_example";
const repository = { id: 1015951989, owner: { id: 361691508 } };
const projectId = "prj_7FliQBcbBiBwGaO2JLrigicnXCRd";
const teamId = "team_MgMQ4MEWijWnYa1R48C2JU5e";
const env = {
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REPOSITORY: "Deskohub/deskohub-site",
  GITHUB_REPOSITORY_ID: String(repository.id),
  GITHUB_REPOSITORY_OWNER_ID: String(repository.owner.id),
  GITHUB_REF: "refs/heads/main",
  GITHUB_REF_PROTECTED: "true",
  GITHUB_WORKFLOW_REF:
    "Deskohub/deskohub-site/.github/workflows/workspace-backend-preview.yml@refs/heads/main",
  GITHUB_WORKFLOW_SHA: "a".repeat(40),
  GITHUB_SHA: "a".repeat(40),
  PREVIEW_OPERATION: "deploy",
  PR_NUMBER: "45",
  PILOT_PR_NUMBER: "45",
  GIT_SHA: sha,
  VERCEL_DEPLOYMENT_ID: deploymentId,
  GH_TOKEN: "stub-github-token",
  VERCEL_TOKEN: "stub-vercel-token",
};

const target = dispatchTarget(env);
const pr = {
  number: 45,
  state: "open",
  draft: false,
  user: { type: "User", login: "developer" },
  base: { repo: repository, ref: "main", sha: "a".repeat(40) },
  head: { repo: repository, ref, sha },
  changed_files: 1,
};

function gitHub({
  record = pr,
  files = [
    [{ filename: "packages/workspace-rpc/package.json", status: "modified" }],
  ],
  branchSha = sha,
} = {}) {
  return async (input) => {
    const url = new URL(input);
    assert.equal(url.origin, "https://api.github.com");
    switch (url.pathname) {
      case "/repos/Deskohub/deskohub-site/pulls/45":
        return Response.json(record);
      case "/repos/Deskohub/deskohub-site/pulls/45/files":
        return Response.json(files[Number(url.searchParams.get("page")) - 1]);
      case "/repos/Deskohub/deskohub-site/git/ref/heads/feat/backend-pilot":
        return Response.json({
          ref: `refs/heads/${ref}`,
          object: { type: "commit", sha: branchSha },
        });
      default:
        assert.fail("Unexpected GitHub lookup");
    }
  };
}

test("requires a protected main dispatch by the fixed repository for the configured PR", () => {
  assert.equal(target.sha, sha);
  for (const change of [
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_REPOSITORY_OWNER_ID: "123" },
    { GITHUB_REPOSITORY_ID: "123" },
    { GITHUB_REF_PROTECTED: "false" },
    { GITHUB_REF: "refs/heads/feat/wrong" },
    { GITHUB_WORKFLOW_REF: `${env.GITHUB_WORKFLOW_REF}-wrong` },
    { GITHUB_WORKFLOW_SHA: sha },
    { GIT_SHA: sha.slice(0, 12) },
    { PILOT_PR_NUMBER: "" },
    { PR_NUMBER: "46" },
    { VERCEL_DEPLOYMENT_ID: "https://other.example" },
  ]) {
    assert.throws(() => dispatchTarget({ ...env, ...change }));
  }
});

test("includes provider packages and root build inputs in the shared classifier", () => {
  assert.equal(
    backendGenerationRequired(["apps/deskohub-workspace/app/page.tsx"]),
    false,
  );
  for (const path of [
    "apps/deskohub-workspace-api/Dockerfile",
    "packages/dotypos/src/client.ts",
    "packages/new/package.json",
    "bun.lock",
    "package.json",
    "turbo.json",
    ".dockerignore",
    "patches/name.patch",
  ])
    assert.equal(backendGenerationRequired([path]), true);
});

test("requires a complete path list and counts both sides of renames", async () => {
  assert.equal(await pullRequestTarget(target, env, gitHub(), true), ref);
  const frontendFile = "apps/deskohub-workspace/new.ts";
  await assert.rejects(
    pullRequestTarget(
      target,
      env,
      gitHub({
        files: [[{ filename: frontendFile, status: "modified" }]],
      }),
      true,
    ),
    /no backend changes/,
  );
  assert.equal(
    await pullRequestTarget(
      target,
      env,
      gitHub({
        files: [
          [
            {
              filename: frontendFile,
              status: "renamed",
              previous_filename: "packages/workspace-backend/old.ts",
            },
          ],
        ],
      }),
      true,
    ),
    ref,
  );
  await assert.rejects(
    pullRequestTarget(
      target,
      env,
      gitHub({
        record: { ...pr, changed_files: 2 },
      }),
      true,
    ),
    /incomplete/,
  );
  const frontendPage = Array.from({ length: 100 }, (_, index) => ({
    filename: `${frontendFile}-${index}`,
  }));
  assert.equal(
    await pullRequestTarget(
      target,
      env,
      gitHub({
        record: { ...pr, changed_files: 101 },
        files: [frontendPage, [{ filename: "bun.lock", status: "modified" }]],
      }),
      true,
    ),
    ref,
  );
});

test("rejects stale, fork, draft and bot heads for deploy", async () => {
  for (const change of [
    { head: { ...pr.head, sha: "c".repeat(40) } },
    { head: { ...pr.head, repo: { ...repository, id: 1 } } },
    { base: { ...pr.base, ref: "release" } },
    { draft: true },
    { state: "closed" },
    { user: { login: "bot[bot]", type: "Bot" } },
  ]) {
    await assert.rejects(
      pullRequestTarget(target, env, gitHub({ record: { ...pr, ...change } })),
    );
  }
  await assert.rejects(
    pullRequestTarget(target, env, gitHub({ branchSha: "c".repeat(40) })),
    /branch no longer/,
  );
  await assert.rejects(
    pullRequestTarget(target, { ...env, GIT_REF: "other" }, gitHub()),
    /eligible internal/,
  );
});

test("cleanup requires the closed current PR head and allows the branch to have been deleted", async () => {
  const cleanup = dispatchTarget({
    ...env,
    PREVIEW_OPERATION: "cleanup",
    VERCEL_DEPLOYMENT_ID: "",
  });
  const request = async (input) => {
    assert.ok(new URL(input).pathname.endsWith("/pulls/45"));
    return Response.json({ ...pr, state: "closed", draft: true });
  };
  assert.equal(await pullRequestTarget(cleanup, env, request), ref);
  await assert.rejects(pullRequestTarget(cleanup, env, gitHub()));
  await assert.rejects(
    pullRequestTarget({ ...cleanup, sha: "c".repeat(40) }, env, request),
  );
});

const host = "workspace-example.vercel.app";
const deployment = {
  id: deploymentId,
  projectId,
  ownerId: teamId,
  target: null,
  public: false,
  readyState: "READY",
  url: host,
  gitSource: { type: "github", repoId: repository.id, ref, sha },
};
const project = {
  id: projectId,
  accountId: teamId,
  ssoProtection: { deploymentType: "preview" },
};
const deploymentEnvironment = "Preview – deskohub-workspace-site";

function vercel({
  record = deployment,
  settings = project,
  status = 401,
  registered = true,
  alias,
} = {}) {
  return async (input, options) => {
    const url = new URL(input);
    if (url.origin === "https://api.vercel.com") {
      assert.equal(url.searchParams.get("teamId"), teamId);
      assert.equal(options.headers.Authorization, `Bearer ${env.VERCEL_TOKEN}`);
      if (url.pathname === `/v13/deployments/${deploymentId}`) {
        assert.equal(url.searchParams.get("withGitRepoInfo"), "true");
        return Response.json(record);
      }
      if (url.pathname === `/v4/aliases/${host}`) {
        return alias
          ? Response.json(alias)
          : new Response(null, { status: 404 });
      }
      assert.equal(url.pathname, `/v9/projects/${projectId}`);
      return Response.json(settings);
    }
    if (url.origin === "https://api.github.com") {
      assert.equal(options.headers.Authorization, `Bearer ${env.GH_TOKEN}`);
      if (url.pathname.endsWith("/deployments")) {
        assert.equal(url.searchParams.get("sha"), sha);
        return Response.json([
          {
            id: 67,
            creator: { login: "vercel[bot]" },
            sha,
            environment: deploymentEnvironment,
          },
        ]);
      }
      assert.ok(url.pathname.endsWith("/deployments/67/statuses"));
      return Response.json([
        {
          creator: { login: "vercel[bot]" },
          state: "success",
          environment_url: registered
            ? `https://${host}`
            : "https://other.vercel.app",
        },
      ]);
    }
    assert.equal(url.origin, `https://${host}`);
    assert.equal(options.method, "HEAD");
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers, undefined);
    return new Response(null, { status });
  };
}

test("matches the exact READY, protected Vercel Git preview by ID, project, repo, ref and SHA", async () => {
  const previewEnv = { ...env, GIT_REF: ref };
  await verifyVercel(target, previewEnv, vercel());
  for (const change of [
    { id: "dpl_other" },
    { projectId: "prj_other" },
    { ownerId: "team_other" },
    { target: "production" },
    { public: true },
    { readyState: "BUILDING" },
    { gitSource: { ...deployment.gitSource, repoId: 1 } },
    { gitSource: { ...deployment.gitSource, ref: "other" } },
    { gitSource: { ...deployment.gitSource, sha: "c".repeat(40) } },
    { url: "workspace-git-branch.vercel.app" },
  ])
    await assert.rejects(
      verifyVercel(
        target,
        previewEnv,
        vercel({ record: { ...deployment, ...change } }),
      ),
    );
  await assert.rejects(
    verifyVercel(
      target,
      previewEnv,
      vercel({ settings: { ...project, ssoProtection: null } }),
    ),
    /Authentication/,
  );
  await assert.rejects(
    verifyVercel(
      target,
      previewEnv,
      vercel({
        alias: {
          alias: host,
          deploymentId,
          protectionBypass: { stub: { scope: "alias-protection-override" } },
        },
      }),
    ),
    /protection exception/,
  );
  await assert.rejects(
    verifyVercel(target, previewEnv, vercel({ registered: false })),
    /deployment record/,
  );
  await assert.rejects(
    verifyVercel(target, previewEnv, vercel({ status: 200 })),
    /require authentication/,
  );
});

test("resolves only the approved non-default Neon branch and its pooled URI", async () => {
  const branchId = "br-preview-pilot";
  const uri =
    "postgresql://neondb_owner:synthetic-password@ep-preview-pooler.eu-west-1.aws.neon.tech/neondb?sslmode=require";
  const previewEnv = {
    ...env,
    GIT_REF: ref,
    APPROVED_NEON_BRANCH_ID: branchId,
    NEON_PROJECT_ID: "preview-project",
    NEON_API_KEY: "stub-neon-key",
  };
  const request = (change) => async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin, "https://console.neon.tech");
    assert.equal(
      options.headers.Authorization,
      `Bearer ${previewEnv.NEON_API_KEY}`,
    );
    if (url.pathname.endsWith(`/branches/${branchId}`)) {
      return Response.json({
        branch: {
          id: branchId,
          name: `preview/${ref}`,
          default: false,
          primary: false,
          parent_id: "br-main",
          ...change,
        },
      });
    }
    assert.ok(url.pathname.endsWith("/connection_uri"));
    assert.equal(url.searchParams.get("branch_id"), branchId);
    assert.equal(url.searchParams.get("pooled"), "true");
    return Response.json({ uri });
  };
  assert.deepEqual(await pooledNeonUrl(previewEnv, request()), {
    branchId,
    uri,
  });
  for (const change of [
    { id: "br-other" },
    { name: "preview/other" },
    { default: true },
    { primary: true },
    { parent_id: null },
  ]) {
    await assert.rejects(
      pooledNeonUrl(previewEnv, request(change)),
      /approved non-default/,
    );
  }
});
