import "server-only";

import { isIP } from "node:net";
import { GoogleIdToken } from "@deskohub/google-oidc";
import {
  type AnonymousCaller,
  BackendUnavailable,
  layerCallerContextClient,
  layerWorkspaceRpcProtocol,
  makeWorkspaceRpcClient,
} from "@deskohub/workspace-rpc";
import { getVercelOidcToken } from "@vercel/oidc";
import { Config, Effect, Layer, Option, type Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { cookieStoreFromHeader } from "posthog-node";
import { env } from "@/env";
import { resolveWorkspaceLocale } from "@/features/i18n/locale-resolution";
import { shareAcrossRequests } from "@/shared/backend/share-across-requests";
import { trustedClientAddressHeaders } from "@/shared/deployment/trusted-client-address";
import {
  PreviewBackendUnavailable,
  previewBackendTarget,
  type WorkspacePreviewBinding,
  withPreviewBackendDeadline,
} from "./workspace-backend-preview.server";

const httpsOrigin = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      value.startsWith("https://") &&
      URL.canParse(value) &&
      new URL(value).origin === value
  )
);

const googleIdentitySegment = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/)
);

const rpcConfig = Config.all({
  audience: Config.schema(httpsOrigin, "WORKSPACE_API_ORIGIN"),
  projectNumber: Config.schema(
    Schema.String.check(Schema.isPattern(/^\d+$/)),
    "WORKSPACE_GCP_PROJECT_NUMBER"
  ),
  pool: Config.schema(googleIdentitySegment, "WORKSPACE_WIF_POOL"),
  provider: Config.schema(googleIdentitySegment, "WORKSPACE_WIF_PROVIDER"),
  serviceAccount: Config.schema(
    Schema.String.check(
      Schema.isPattern(/^[\w.-]+@[\w.-]+\.iam\.gserviceaccount\.com$/)
    ),
    "WORKSPACE_FRONTEND_SERVICE_ACCOUNT"
  ),
});

const unavailable = () => new BackendUnavailable({ reason: "authorization" });

const googleIdTokens = shareAcrossRequests(
  GoogleIdToken.Default.pipe(Layer.provide(FetchHttpClient.layer))
);

export const authenticatedWorkspaceBackend = Effect.gen(function* () {
  const { audience, projectNumber, pool, provider, serviceAccount } =
    yield* Effect.mapError(rpcConfig, unavailable);
  const tokens = yield* GoogleIdToken;
  const identity = {
    serviceAccount,
    audience,
    workloadIdentityProvider: `//iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${pool}/providers/${provider}`,
  };
  return {
    audience,
    authorization: tokens
      .get({
        ...identity,
        getSubjectToken: () => getVercelOidcToken(),
      })
      .pipe(Effect.mapError(unavailable)),
    invalidateAuthorization: (token: Redacted.Redacted<string>) =>
      tokens.evict(identity, token),
  };
}).pipe(Effect.provide(googleIdTokens));

export const workspaceRpcCaller = (request: Request): AnonymousCaller => {
  const { headers } = request;
  const [trustedHeader] = trustedClientAddressHeaders(env);
  const clientAddress = trustedHeader ? headers.get(trustedHeader) : null;
  const userAgent = headers.get("user-agent");

  return {
    correlationId: crypto.randomUUID(),
    locale: resolveWorkspaceLocale(
      {
        pathname: new URL(request.url).pathname,
        cookies: cookieStoreFromHeader(headers.get("cookie") ?? ""),
        headers,
      },
      undefined
    ),
    clientAddress: Option.fromNullishOr(clientAddress).pipe(
      Option.filter((address) => isIP(address) !== 0)
    ),
    userAgent: Option.fromNullishOr(userAgent).pipe(
      Option.filter((value) => value.length > 0 && value.length <= 2048)
    ),
  };
};

/** Each inbound request gets its own client scope and caller headers. */
export const withWorkspaceRpcClient = <A, E>(
  caller: AnonymousCaller,
  preview: WorkspacePreviewBinding | undefined,
  use: (
    client: Effect.Success<ReturnType<typeof makeWorkspaceRpcClient>>
  ) => Effect.Effect<A, E>
) => {
  const call = Effect.gen(function* () {
    const { audience, ...auth } = yield* authenticatedWorkspaceBackend;
    const target = preview
      ? yield* previewBackendTarget(audience, preview)
      : { url: audience };
    const transport = layerWorkspaceRpcProtocol({ ...target, ...auth }).pipe(
      Layer.provide(FetchHttpClient.layer)
    );
    return yield* makeWorkspaceRpcClient().pipe(
      Effect.flatMap(use),
      Effect.scoped,
      Effect.provide(Layer.merge(transport, layerCallerContextClient(caller)))
    );
  }).pipe(
    Effect.catchDefect(() =>
      Effect.fail(new BackendUnavailable({ reason: "protocol" }))
    )
  );
  return preview
    ? withPreviewBackendDeadline(
        call.pipe(
          Effect.mapError((error) =>
            error instanceof BackendUnavailable
              ? new PreviewBackendUnavailable()
              : error
          )
        )
      )
    : call;
};
