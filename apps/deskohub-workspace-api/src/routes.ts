import {
  backendRevisionHeader,
  cloudRunRevisionHeader,
  PreviewNeonBranchId,
  PreviewRuntimeBinding,
  previewDatabaseEndpoint,
  previewGenerationHeader,
  previewRuntimeGeneration,
  taggedCloudRunOrigin,
} from "@deskohub/workspace-cloud-run/preview-generation";
import { WorkspaceServiceRole } from "@deskohub/workspace-cloud-run/service-role";
import { Config, Effect, Layer, Redacted } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { workspaceRpcOptions } from "./rpc-options";

const previewBinding = Config.all({
  commitSha: Config.schema(
    PreviewRuntimeBinding.fields.commitSha,
    "WORKSPACE_PREVIEW_COMMIT_SHA"
  ),
  deploymentId: Config.schema(
    PreviewRuntimeBinding.fields.deploymentId,
    "WORKSPACE_PREVIEW_DEPLOYMENT_ID"
  ),
  branchTag: Config.schema(
    PreviewRuntimeBinding.fields.branchTag,
    "WORKSPACE_PREVIEW_BRANCH_TAG"
  ),
  databaseEndpoint: Config.schema(
    PreviewRuntimeBinding.fields.databaseEndpoint,
    "WORKSPACE_PREVIEW_DATABASE_ENDPOINT"
  ),
});

const previewProof = (role: WorkspaceServiceRole) =>
  Effect.gen(function* () {
    const binding = yield* previewBinding;
    yield* Config.schema(
      PreviewNeonBranchId,
      "WORKSPACE_PREVIEW_NEON_BRANCH_ID"
    );
    const cloudRunRevision = yield* Config.String("K_REVISION");
    const workerOrigin = yield* Config.String(
      "WORKSPACE_PREVIEW_WORKER_ORIGIN"
    );
    const revisionPrefix = `workspace-${role}-preview-`;
    const workerTag = cloudRunRevision.slice(revisionPrefix.length);
    if (
      !cloudRunRevision.startsWith(revisionPrefix) ||
      !/^g-[0-9a-f]{16}$/.test(workerTag)
    ) {
      return undefined;
    }

    const prefix = `https://${workerTag}---`;
    if (
      !workerOrigin.startsWith(prefix) ||
      taggedCloudRunOrigin(
        `https://${workerOrigin.slice(prefix.length)}`,
        workerTag
      ) !== workerOrigin
    ) {
      return undefined;
    }

    if (role === "api") {
      const databaseUrl = yield* Config.Redacted("DATABASE_URL");
      const connectionString = Redacted.value(databaseUrl);
      const url = URL.parse(connectionString);
      // The Postgres driver lets query parameters override the URL endpoint.
      if (
        !url ||
        (url.port !== "" && url.port !== "5432") ||
        url.searchParams.has("host") ||
        url.searchParams.has("port") ||
        url.searchParams.has("dbname") ||
        previewDatabaseEndpoint(connectionString) !== binding.databaseEndpoint
      ) {
        return undefined;
      }
    }

    return {
      commitSha: binding.commitSha,
      cloudRunRevision,
      generation: previewRuntimeGeneration(binding),
      workerTag,
    };
  }).pipe(Effect.orElseSucceed(() => undefined));

const probePath = "/api/internal/backend-preview";
const privateHeaders = { "cache-control": "private, no-store" };
const unavailable = HttpServerResponse.empty({
  status: 503,
  headers: privateHeaders,
});

// A preview client must never dispatch on a revision without a preview binding.
export const rejectPreviewGeneration = HttpRouter.middleware((httpEffect) =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, ({ headers }) =>
    headers[previewGenerationHeader] === undefined
      ? httpEffect
      : Effect.succeed(unavailable)
  )
).layer;

export const workspaceRoutes = <E, R>(apiRoutes: Layer.Layer<never, E, R>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const role = yield* Config.schema(
        WorkspaceServiceRole,
        "WORKSPACE_SERVICE_ROLE"
      );
      const stage = yield* Config.String("WORKSPACE_DEPLOYMENT_STAGE").pipe(
        Config.withDefault("")
      );
      const health = HttpServerResponse.text("ok");
      const healthRoutes = Layer.mergeAll(
        HttpRouter.add("GET", "/healthz", health),
        HttpRouter.add("GET", "/health", health)
      );
      // Worker handlers move to Cloud Run in their own cutovers.
      const roleRoutes = role === "api" ? apiRoutes : Layer.empty;
      if (stage !== "preview") {
        return Layer.merge(
          healthRoutes,
          roleRoutes.pipe(Layer.provide(rejectPreviewGeneration))
        );
      }

      const proof = yield* previewProof(role);
      if (!proof) {
        const rpcUnavailable =
          role === "api"
            ? HttpRouter.add("POST", workspaceRpcOptions.path, unavailable)
            : Layer.empty;
        return Layer.mergeAll(
          healthRoutes,
          rpcUnavailable,
          HttpRouter.add("GET", probePath, unavailable)
        );
      }

      const requireGeneration = HttpRouter.middleware((httpEffect) =>
        Effect.flatMap(HttpServerRequest.HttpServerRequest, ({ headers }) =>
          headers[previewGenerationHeader] === proof.generation
            ? Effect.map(
                httpEffect,
                HttpServerResponse.setHeaders({
                  [backendRevisionHeader]: proof.commitSha,
                  [cloudRunRevisionHeader]: proof.cloudRunRevision,
                  [previewGenerationHeader]: proof.generation,
                })
              )
            : Effect.succeed(unavailable)
        )
      ).layer;
      // Cloud Run IAM protects this endpoint before the request reaches the app.
      const probe = HttpRouter.add(
        "GET",
        probePath,
        HttpServerResponse.json(proof, { headers: privateHeaders })
      );
      return Layer.merge(
        healthRoutes,
        Layer.merge(roleRoutes, probe).pipe(Layer.provide(requireGeneration))
      );
    })
  );
