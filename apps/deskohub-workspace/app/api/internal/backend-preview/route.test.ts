import "@/shared/testing/workspace-test-env";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  test,
} from "bun:test";
import { CallerContextLive } from "@deskohub/workspace-backend";
import {
  backendRevisionHeader,
  cloudRunRevisionHeader,
  PreviewRuntimeBinding,
  previewBackendBranchTag,
  previewDatabaseEndpoint,
  previewGenerationHeader,
  previewRuntimeGeneration,
  taggedCloudRunOrigin,
} from "@deskohub/workspace-cloud-run/preview-generation";
import {
  EmailPreferencesRpcs,
  MarketingManagementAccessToken,
  WorkspaceRpcSerialization,
} from "@deskohub/workspace-rpc";
import { ConfigProvider, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { RpcServer } from "effect/rpc";

import {
  emailPreferencesBackend,
  emailPreferencesTransport,
} from "@/shared/rpc/workspace-backend-preview.server";

const previewApiOrigin = "https://workspace-api-preview-example.run.app";
const googleProject = "example-sandbox";
const branch = "feature/preview-generation";
const branchTag = previewBackendBranchTag(branch);
const taggedOrigin = taggedCloudRunOrigin(previewApiOrigin, branchTag);
const databaseUrl =
  "postgresql://synthetic:synthetic@ep-preview-pooler.eu-central-1.aws.neon.tech/workspace";
const commitSha = "a".repeat(40);
const deploymentId = "dpl_synthetic";
const binding = PreviewRuntimeBinding.make({
  commitSha,
  deploymentId,
  branchTag,
  databaseEndpoint: previewDatabaseEndpoint(databaseUrl) ?? "",
});
const generation = previewRuntimeGeneration(binding);
const staleGeneration = previewRuntimeGeneration({
  ...binding,
  deploymentId: "dpl_previousPreview",
});
const workerTag = "g-0123456789abcdef";
const cloudRunRevision = `workspace-api-preview-${workerTag}`;
const proofHeaders = {
  [backendRevisionHeader]: commitSha,
  [cloudRunRevisionHeader]: cloudRunRevision,
  [previewGenerationHeader]: generation,
};
const testBypass = "synthetic-preview-bypass";
const signedToken = `${Buffer.from(JSON.stringify(["send-synthetic", "customer-synthetic"])).toString("base64url")}.${"s".repeat(43)}`;
const managementToken = MarketingManagementAccessToken.make("A".repeat(43));
const subjectToken = "synthetic-vercel-identity";
const idToken = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.c2ln`;

mock.module("@vercel/oidc", () => ({
  getVercelOidcToken: async () => subjectToken,
}));

const { GET, POST } = await import("../../email-campaigns/unsubscribe/route");
const { GET: probe } = await import("./route");

let withdrawals = 0;
let requests: Request[] = [];
let unexpectedResponse: Response | undefined;
let proofResponse: (request: Request) => Response = () =>
  Response.json(
    {
      commitSha,
      cloudRunRevision,
      generation,
      workerTag,
      ignored: "untrusted",
    },
    { headers: { ...proofHeaders, "x-upstream-only": "synthetic" } }
  );
let rpcProofHeaders: HeadersInit = proofHeaders;
let lastMintAudience: string | undefined;
let mintRequests = 0;

const rpcServer = HttpRouter.toWebHandler(
  RpcServer.layerHttp({
    group: EmailPreferencesRpcs,
    path: "/rpc/preview",
    protocol: "http",
    disableFatalDefects: true,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        WorkspaceRpcSerialization,
        EmailPreferencesRpcs.toLayer(
          EmailPreferencesRpcs.of({
            "EmailPreferences.openPreferences": () =>
              Effect.succeed({ accessToken: managementToken }),
            "EmailPreferences.unsubscribeOneClick": () =>
              Effect.sync(() => {
                withdrawals += 1;
                return "withdrawn";
              }),
          })
        ),
        CallerContextLive,
        HttpServer.layerServices
      )
    )
  ),
  { disableLogger: true }
);

const originalFetch = globalThis.fetch;

const previewEnv = {
  VERCEL_ENV: "preview",
  WORKSPACE_DEPLOYMENT_STAGE: "preview",
  WORKSPACE_RUNTIME_HOST: "vercel",
  WORKSPACE_EMAIL_PREFERENCES_TRANSPORT: "rpc",
  WORKSPACE_API_ORIGIN: previewApiOrigin,
  WORKSPACE_GCP_PROJECT_NUMBER: "123456789",
  WORKSPACE_WIF_POOL: "workspace-vercel",
  WORKSPACE_WIF_PROVIDER: "vercel",
  WORKSPACE_FRONTEND_SERVICE_ACCOUNT: `workspace-frontend@${googleProject}.iam.gserviceaccount.com`,
  VERCEL_GIT_COMMIT_SHA: commitSha,
  VERCEL_DEPLOYMENT_ID: deploymentId,
  VERCEL_GIT_COMMIT_REF: branch,
  DATABASE_URL: databaseUrl,
  VERCEL_AUTOMATION_BYPASS_SECRET: testBypass,
};
const originalEnv = new Map<string, string | undefined>();

beforeAll(() => {
  for (const [name, value] of Object.entries(previewEnv)) {
    originalEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      switch (url.origin) {
        case "https://sts.googleapis.com":
          return Response.json({
            access_token: "synthetic-federated-token",
            expires_in: 3600,
            token_type: "Bearer",
          });
        case "https://iamcredentials.googleapis.com": {
          const mint = await request.json();
          lastMintAudience = mint.audience;
          mintRequests += 1;
          return Response.json({ token: idToken });
        }
        case taggedOrigin: {
          requests.push(request.clone());
          if (url.pathname === "/api/internal/backend-preview") {
            return proofResponse(request);
          }
          if (unexpectedResponse) {
            return unexpectedResponse;
          }
          const response = await rpcServer.handler(request);
          const headers = new Headers(response.headers);
          for (const [name, value] of new Headers(rpcProofHeaders)) {
            headers.set(name, value);
          }
          return new Response(response.body, {
            status: response.status,
            headers,
          });
        }
        default:
          throw new Error(`Unexpected HTTP origin ${url.origin}`);
      }
    },
    { preconnect: originalFetch.preconnect }
  );
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of originalEnv) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  await rpcServer.dispose();
});

const unsubscribeRequest = (token: string, init?: RequestInit) =>
  new Request(
    `https://workspace.deskohub.test/api/email-campaigns/unsubscribe?token=${encodeURIComponent(token)}`,
    init
  );

const probeRequest = (headers?: HeadersInit, search = "") =>
  new Request(
    `https://workspace.deskohub.test/api/internal/backend-preview${search}`,
    headers === undefined ? undefined : { headers }
  );

const authorizedHeaders = { "x-vercel-protection-bypass": testBypass };

beforeEach(() => {
  requests = [];
  rpcProofHeaders = proofHeaders;
});

afterEach(() => {
  unexpectedResponse = undefined;
});

test("routes GET and POST to the tagged revision and relays the verified SHA", async () => {
  const getResponse = await GET(
    unsubscribeRequest(signedToken, {
      headers: { [previewGenerationHeader]: "user-supplied" },
    })
  );
  const postResponse = await POST(
    unsubscribeRequest(signedToken, { method: "POST" })
  );

  expect(getResponse.status).toBe(303);
  expect(postResponse.status).toBe(200);
  expect(lastMintAudience).toBe(previewApiOrigin);
  expect(requests).toHaveLength(2);
  for (const request of requests) {
    expect(request.url).toBe(`${taggedOrigin}/rpc/preview`);
    expect(request.headers.get(previewGenerationHeader)).toBe(generation);
  }
  for (const response of [getResponse, postResponse]) {
    expect(response.headers.get(backendRevisionHeader)).toBe(commitSha);
    expect(response.headers.has(previewGenerationHeader)).toBeFalse();
    expect(response.headers.has(cloudRunRevisionHeader)).toBeFalse();
  }
});

test.each([
  ["missing", {}],
  [
    "stale generation",
    { ...proofHeaders, [previewGenerationHeader]: staleGeneration },
  ],
  ["wrong SHA", { ...proofHeaders, [backendRevisionHeader]: "b".repeat(40) }],
] satisfies [string, HeadersInit][])(
  "returns 503 and omits revision proof for %s RPC headers",
  async (_label, headers) => {
    rpcProofHeaders = headers;
    const response = await GET(unsubscribeRequest(signedToken));

    expect(response.status).toBe(503);
    expect(response.headers.has("location")).toBeFalse();
    expect(response.headers.has(backendRevisionHeader)).toBeFalse();
    expect(requests).toHaveLength(1);
  }
);

test("returns 503 when one-click RPC is unavailable", async () => {
  unexpectedResponse = new Response(null, { status: 503 });
  const numberOfWithdrawals = withdrawals;
  const response = await POST(
    unsubscribeRequest(signedToken, { method: "POST" })
  );

  expect(response.status).toBe(503);
  expect(response.headers.has(backendRevisionHeader)).toBeFalse();
  expect(withdrawals).toBe(numberOfWithdrawals);
  expect(requests).toHaveLength(1);
});

test.each([
  { WORKSPACE_DEPLOYMENT_STAGE: "production" },
  { DATABASE_URL: "postgres://localhost/workspace" },
])("rejects opt-in when the runtime cannot be bound", async (overrides) => {
  const provider = ConfigProvider.fromUnknown({ ...previewEnv, ...overrides });
  const backend = Effect.provideService(
    emailPreferencesBackend,
    ConfigProvider.ConfigProvider,
    provider
  );

  await expect(Effect.runPromise(backend)).rejects.toMatchObject({
    _tag: "PreviewBackendUnavailable",
  });
});

test("keeps preview local until RPC is explicitly enabled", async () => {
  const provider = ConfigProvider.fromUnknown({
    VERCEL_ENV: "preview",
    WORKSPACE_DEPLOYMENT_STAGE: "preview",
  });
  const transport = Effect.provideService(
    emailPreferencesTransport,
    ConfigProvider.ConfigProvider,
    provider
  );

  expect(await Effect.runPromise(transport)).toBe("local");
});

test("requires the configured bypass secret in the preview header", async () => {
  const unauthorized = [
    probeRequest(undefined, `?x-vercel-protection-bypass=${testBypass}`),
    probeRequest({ "x-vercel-protection-bypass": "wrong-secret" }),
  ];
  for (const request of unauthorized) {
    const response = await probe(request);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  expect(requests).toHaveLength(0);
});

test("returns only matching proof and headers from the protected probe", async () => {
  const response = await probe(probeRequest(authorizedHeaders));

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.has("x-upstream-only")).toBeFalse();
  for (const [header, value] of Object.entries(proofHeaders)) {
    expect(response.headers.get(header)).toBe(value);
  }
  expect(await response.json()).toEqual({
    commitSha,
    cloudRunRevision,
    generation,
    workerTag,
  });
  expect(requests).toHaveLength(1);
  const [request] = requests;
  expect(request.url).toBe(`${taggedOrigin}/api/internal/backend-preview`);
  expect(request.cache).toBe("no-store");
  expect(request.redirect).toBe("manual");
  expect(request.headers.get("authorization")).toBe(`Bearer ${idToken}`);
  expect(request.headers.get(previewGenerationHeader)).toBe(generation);
  expect(request.headers.has("x-vercel-protection-bypass")).toBeFalse();
});

test("evicts a rejected Google token so the next probe can recover", async () => {
  expect((await probe(probeRequest(authorizedHeaders))).status).toBe(200);
  const matchingProof = proofResponse;
  const cachedMintCount = mintRequests;
  proofResponse = () => new Response(null, { status: 401 });
  try {
    expect((await probe(probeRequest(authorizedHeaders))).status).toBe(503);
    expect(mintRequests).toBe(cachedMintCount);
  } finally {
    proofResponse = matchingProof;
  }

  expect((await probe(probeRequest(authorizedHeaders))).status).toBe(200);
  expect(mintRequests).toBe(cachedMintCount + 1);
  expect(requests).toHaveLength(3);
});

test("returns 503 and aborts an upstream response whose body stalls", async () => {
  const matchingProof = proofResponse;
  let aborted = false;
  proofResponse = ({ signal }) =>
    new Response(
      new ReadableStream({
        start(controller) {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              controller.error(signal.reason);
            },
            { once: true }
          );
        },
      }),
      { headers: proofHeaders }
    );
  try {
    const response = await probe(probeRequest(authorizedHeaders));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(aborted).toBeTrue();
  } finally {
    proofResponse = matchingProof;
  }
}, 8000);

test.each([
  [
    "missing headers",
    () => Response.json({ commitSha, cloudRunRevision, generation, workerTag }),
  ],
  [
    "stale proof",
    () =>
      Response.json(
        { commitSha, cloudRunRevision, generation: staleGeneration, workerTag },
        { headers: proofHeaders }
      ),
  ],
  [
    "unbound worker tag",
    () =>
      Response.json(
        {
          commitSha,
          cloudRunRevision,
          generation,
          workerTag: "g-fedcba9876543210",
        },
        { headers: proofHeaders }
      ),
  ],
  [
    "revision header mismatch",
    () =>
      Response.json(
        { commitSha, cloudRunRevision, generation, workerTag },
        { headers: { ...proofHeaders, [cloudRunRevisionHeader]: "stale" } }
      ),
  ],
  [
    "redirect",
    () =>
      Response.redirect(
        "https://redirect.example/api/internal/backend-preview"
      ),
  ],
] satisfies [string, () => Response][])(
  "returns an empty, no-store 503 for %s",
  async (_label, responseForCase) => {
    const matchingProof = proofResponse;
    proofResponse = responseForCase;
    try {
      const response = await probe(probeRequest(authorizedHeaders));

      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.has(backendRevisionHeader)).toBeFalse();
      expect(await response.text()).toBe("");
      expect(requests).toHaveLength(1);
    } finally {
      proofResponse = matchingProof;
    }
  }
);
