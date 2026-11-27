import { isMatchingSecret } from "@deskohub/secret-comparison";
import {
  backendRevisionHeader,
  cloudRunRevisionHeader,
  previewGenerationHeader,
} from "@deskohub/workspace-cloud-run/preview-generation";
import { Config, Effect, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { defineWorkspaceRoute } from "@/shared/backend/workspace-route";
import {
  emailPreferencesTransport,
  PreviewBackendUnavailable,
  previewBackendTarget,
  withPreviewBackendDeadline,
  workspacePreviewBinding,
} from "@/shared/rpc/workspace-backend-preview.server";
import { authenticatedWorkspaceBackend } from "@/shared/rpc/workspace-rpc-client.server";

const noStore = { "cache-control": "no-store" };

const notFound = () => new Response(null, { status: 404, headers: noStore });

const unavailable = () => new Response(null, { status: 503, headers: noStore });

const bypassSecret = Config.option(
  Config.Redacted("VERCEL_AUTOMATION_BYPASS_SECRET")
);

const authorized = (request: Request) =>
  bypassSecret.pipe(
    Effect.map((configured) => {
      const presented = request.headers.get("x-vercel-protection-bypass");
      return (
        presented !== null &&
        presented.length > 0 &&
        Option.isSome(configured) &&
        isMatchingSecret(presented, Redacted.value(configured.value))
      );
    }),
    Effect.orElseSucceed(() => false)
  );

const decodeProof = Schema.decodeUnknownEffect(
  Schema.Struct({
    commitSha: Schema.String,
    cloudRunRevision: Schema.String,
    generation: Schema.String,
    workerTag: Schema.String.check(Schema.isPattern(/^g-[0-9a-f]{16}$/)),
  })
);

const readPreviewBackend = Effect.gen(function* () {
  const preview = yield* workspacePreviewBinding;
  const { audience, authorization, invalidateAuthorization } =
    yield* authenticatedWorkspaceBackend;
  const { expectedResponseHeaders, requestHeaders, url } =
    yield* previewBackendTarget(audience, preview);
  const token = yield* authorization;
  const client = HttpClient.withScope(yield* HttpClient.HttpClient);
  const request = HttpClientRequest.get(`${url}/api/internal/backend-preview`, {
    headers: requestHeaders,
  }).pipe(HttpClientRequest.bearerToken(token));
  const upstream = yield* client.execute(request).pipe(
    Effect.provideService(FetchHttpClient.RequestInit, {
      cache: "no-store",
      redirect: "manual",
    })
  );
  if (upstream.status === 401) {
    yield* invalidateAuthorization(token);
  }
  if (
    upstream.status !== 200 ||
    Object.entries(expectedResponseHeaders).some(
      ([name, expected]) => upstream.headers[name] !== expected
    )
  ) {
    return yield* new PreviewBackendUnavailable();
  }
  const proof = yield* upstream.json.pipe(Effect.flatMap(decodeProof));
  if (
    proof.commitSha !== preview.commitSha ||
    proof.generation !== preview.generation ||
    proof.cloudRunRevision !== `workspace-api-preview-${proof.workerTag}` ||
    proof.cloudRunRevision !== upstream.headers[cloudRunRevisionHeader]
  ) {
    return yield* new PreviewBackendUnavailable();
  }
  return Response.json(proof, {
    headers: {
      ...noStore,
      [backendRevisionHeader]: proof.commitSha,
      [cloudRunRevisionHeader]: proof.cloudRunRevision,
      [previewGenerationHeader]: proof.generation,
    },
  });
}).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer));

export const GET = defineWorkspaceRoute(
  {
    operation: "backendPreview",
    cancellation: "interrupt-on-disconnect",
    caller: "service",
    fallback: {
      failureCode: "backend_preview_unavailable",
      response: unavailable,
    },
  },
  Effect.fn("backendPreview.read")(function* (request: Request) {
    if (!(yield* authorized(request))) {
      return notFound();
    }
    const transport = yield* emailPreferencesTransport.pipe(
      Effect.orElseSucceed(() => "local")
    );
    if (transport !== "preview-rpc") {
      return notFound();
    }
    return yield* withPreviewBackendDeadline(readPreviewBackend).pipe(
      Effect.orElseSucceed(unavailable)
    );
  })
);
