import { expect, test } from "bun:test";
import {
  backendRevisionHeader,
  cloudRunRevisionHeader,
  previewDatabaseEndpoint,
  previewGenerationHeader,
  previewRuntimeGeneration,
} from "@deskohub/workspace-cloud-run/preview-generation";
import { ConfigProvider, Effect, Layer, Schema } from "effect";
import { HttpRouter } from "effect/http";
import { Rpc, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";
import { workspaceHttpRouterOptions } from "./http-server";
import { workspaceRoutes } from "./routes";
import { workspaceRpcOptions } from "./rpc-options";

const directUrl = "postgresql://ep-synthetic.eu.aws.neon.tech/workspace";
const pooledUrl =
  "postgresql://ep-synthetic-pooler.eu.aws.neon.tech/workspace?sslmode=require";
const databaseEndpoint = previewDatabaseEndpoint(directUrl);
if (!databaseEndpoint) {
  throw new Error("Invalid synthetic Neon URL");
}
const binding = {
  commitSha: "a".repeat(40),
  deploymentId: "dpl_synthetic",
  branchTag: "b-0123456789ab",
  databaseEndpoint,
};
const generation = previewRuntimeGeneration(binding);
const workerTag = "g-0123456789abcdef";
const revision = `workspace-api-preview-${workerTag}`;
const routingEnvironment = {
  WORKSPACE_DEPLOYMENT_STAGE: "preview",
  WORKSPACE_SERVICE_ROLE: "api",
  WORKSPACE_PREVIEW_COMMIT_SHA: binding.commitSha,
  WORKSPACE_PREVIEW_DEPLOYMENT_ID: binding.deploymentId,
  WORKSPACE_PREVIEW_BRANCH_TAG: binding.branchTag,
  WORKSPACE_PREVIEW_NEON_BRANCH_ID: "br-synthetic",
  WORKSPACE_PREVIEW_DATABASE_ENDPOINT: binding.databaseEndpoint,
  WORKSPACE_PREVIEW_WORKER_ORIGIN: `https://${workerTag}---workspace-tasks-worker-preview-123.europe-west1.run.app`,
  K_REVISION: revision,
  DATABASE_URL: pooledUrl,
};

const EchoRpcs = RpcGroup.make(
  Rpc.make("Echo", {
    payload: { message: Schema.String },
    success: Schema.String,
  })
);

const startRoutes = (environment: Record<string, string | undefined> = {}) => {
  const handledMessages: string[] = [];
  let installed = false;
  const handlers = EchoRpcs.toLayer(
    Effect.sync(() => {
      installed = true;
      return EchoRpcs.of({
        Echo: ({ message }) =>
          Effect.sync(() => {
            handledMessages.push(message);
            return message;
          }),
      });
    })
  );
  const rpcRoutes = RpcServer.layerHttp({
    ...workspaceRpcOptions,
    group: EchoRpcs,
  }).pipe(Layer.provide(Layer.merge(handlers, RpcSerialization.layerJson)));

  return {
    ...HttpRouter.toWebHandler(
      workspaceRoutes(rpcRoutes).pipe(
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnvRecord({
              ...routingEnvironment,
              ...environment,
            })
          )
        )
      ),
      workspaceHttpRouterOptions
    ),
    handledMessages,
    get installed() {
      return installed;
    },
  };
};

const rpcRequest = (expected?: string) =>
  new Request("http://localhost/rpc", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(expected === undefined
        ? {}
        : { [previewGenerationHeader]: expected }),
    },
    body: JSON.stringify({
      _tag: "Request",
      id: "1",
      tag: "Echo",
      payload: { message: "dispatched" },
      headers: [],
    }),
  });

const probeRequest = (expected?: string) =>
  new Request("http://localhost/api/internal/backend-preview", {
    headers:
      expected === undefined ? {} : { [previewGenerationHeader]: expected },
  });

const expectProof = (response: Response, cloudRunRevision: string) => {
  expect(response.headers.get(backendRevisionHeader)).toBe(binding.commitSha);
  expect(response.headers.get(cloudRunRevisionHeader)).toBe(cloudRunRevision);
  expect(response.headers.get(previewGenerationHeader)).toBe(generation);
};

test("preview RPC rejects missing, stale and duplicate generations before reading the body", async () => {
  const server = startRoutes();
  try {
    for (const expected of [
      undefined,
      "f".repeat(64),
      `${generation}, ${generation}`,
    ]) {
      const request = rpcRequest(expected);
      const response = await server.handler(request);
      expect(response.status).toBe(503);
      expect(response.headers.get(previewGenerationHeader)).toBeNull();
      expect(request.bodyUsed).toBe(false);
      expect(server.handledMessages).toEqual([]);
    }

    const request = rpcRequest(generation);
    const response = await server.handler(request);
    expect(response.status).toBe(200);
    expectProof(response, revision);
    expect(request.bodyUsed).toBe(true);
    expect(server.handledMessages).toEqual(["dispatched"]);
    expect(await response.json()).toEqual([
      {
        _tag: "Exit",
        requestId: "1",
        exit: { _tag: "Success", value: "dispatched" },
      },
    ]);
  } finally {
    await server.dispose();
  }
});

test.each([
  ["WORKSPACE_PREVIEW_COMMIT_SHA", "invalid"],
  ["WORKSPACE_PREVIEW_DEPLOYMENT_ID", undefined],
  ["WORKSPACE_PREVIEW_BRANCH_TAG", "arbitrary-branch"],
  ["WORKSPACE_PREVIEW_NEON_BRANCH_ID", "invalid"],
  ["WORKSPACE_PREVIEW_DATABASE_ENDPOINT", "invalid"],
  [
    "WORKSPACE_PREVIEW_WORKER_ORIGIN",
    "https://g-ffffffffffffffff---tasks-123.run.app",
  ],
  [
    "WORKSPACE_PREVIEW_WORKER_ORIGIN",
    `${routingEnvironment.WORKSPACE_PREVIEW_WORKER_ORIGIN}/rpc`,
  ],
  ["K_REVISION", undefined],
  ["K_REVISION", `workspace-tasks-worker-preview-${workerTag}`],
  ["DATABASE_URL", "postgresql://ep-stale.eu.aws.neon.tech/workspace"],
  ["DATABASE_URL", `${directUrl}?%68ost=ep-stale.eu.aws.neon.tech`],
  ["DATABASE_URL", `${directUrl}?dbname=other`],
  ["DATABASE_URL", `${directUrl}?port=5433`],
  ["DATABASE_URL", directUrl.replace("/workspace", ":5433/workspace")],
  ["DATABASE_URL", undefined],
])(
  "invalid preview binding returns 503 without installing RPC routes (%s)",
  async (key, value) => {
    const server = startRoutes({ [key]: value });
    try {
      const request = rpcRequest(generation);
      const response = await server.handler(request);
      expect(response.status).toBe(503);
      expect(await response.text()).toBe("");
      expect(request.bodyUsed).toBe(false);
      expect(server.installed).toBe(false);
      expect((await server.handler(probeRequest(generation))).status).toBe(503);
      const health = await server.handler(
        new Request("http://localhost/healthz")
      );
      expect(health.status).toBe(200);
      expect(await health.text()).toBe("ok");
      expect(health.headers.get(previewGenerationHeader)).toBeNull();
    } finally {
      await server.dispose();
    }
  }
);

test.each(["api", "tasks-worker", "scheduler-worker"])(
  "preview %s probe returns only the expected generation proof",
  async (role) => {
    const cloudRunRevision = `workspace-${role}-preview-${workerTag}`;
    const server = startRoutes({
      WORKSPACE_SERVICE_ROLE: role,
      K_REVISION: cloudRunRevision,
      DATABASE_URL: role === "api" ? pooledUrl : undefined,
    });
    try {
      expect((await server.handler(probeRequest())).status).toBe(503);
      expect((await server.handler(probeRequest("stale"))).status).toBe(503);
      const response = await server.handler(probeRequest(generation));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expectProof(response, cloudRunRevision);
      expect(await response.json()).toEqual({
        commitSha: binding.commitSha,
        cloudRunRevision,
        generation,
        workerTag,
      });

      if (role !== "api") {
        expect((await server.handler(rpcRequest(generation))).status).toBe(404);
        expect(server.installed).toBe(false);
      }
    } finally {
      await server.dispose();
    }
  }
);

test.each([undefined, "production", "sandbox"])(
  "stage %s keeps ordinary RPC dispatch and rejects preview RPC before reading the body",
  async (stage) => {
    const server = startRoutes({
      WORKSPACE_DEPLOYMENT_STAGE: stage,
      WORKSPACE_PREVIEW_COMMIT_SHA: undefined,
    });
    try {
      for (const supplied of [generation, ""]) {
        const request = rpcRequest(supplied);
        expect((await server.handler(request)).status).toBe(503);
        expect(request.bodyUsed).toBe(false);
        expect(server.handledMessages).toEqual([]);
      }
      const response = await server.handler(rpcRequest());
      expect(response.status).toBe(200);
      expect(response.headers.get(previewGenerationHeader)).toBeNull();
      expect(server.handledMessages).toEqual(["dispatched"]);
      expect((await server.handler(probeRequest(generation))).status).toBe(404);
    } finally {
      await server.dispose();
    }
  }
);
