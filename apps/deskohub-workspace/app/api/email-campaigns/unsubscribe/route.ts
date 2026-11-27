import { backendRevisionHeader } from "@deskohub/workspace-cloud-run/preview-generation";
import {
  CampaignUnsubscribeRejected,
  CampaignUnsubscribeToken,
} from "@deskohub/workspace-rpc";
import { Effect, Match, Schema } from "effect";
import { NextResponse } from "next/server";
import { CampaignUnsubscribeService } from "@/features/email-campaigns/backend/campaign-unsubscribe.service";
import { getRuntimeMarketingPreferencesAccessUrl } from "@/features/legal/marketing-preferences-access-url";
import { hasSignedClaimsEncoding } from "@/shared/backend/signed-claims";
import {
  defineWorkspaceRoute,
  WorkspaceRouteFailure,
} from "@/shared/backend/workspace-route";
import { emailPreferencesBackend } from "@/shared/rpc/workspace-backend-preview.server";
import {
  withWorkspaceRpcClient,
  workspaceRpcCaller,
} from "@/shared/rpc/workspace-rpc-client.server";

const invalidLink = () =>
  new WorkspaceRouteFailure({
    statusCode: 400,
    publicMessage: "This unsubscribe link is invalid.",
  });

const linkToken = (request: Request) =>
  new URL(request.url).searchParams.get("token") ?? "";

const previewUnavailable = () =>
  new WorkspaceRouteFailure({
    statusCode: 503,
    publicMessage: "Email preferences are temporarily unavailable.",
  });

const revisionHeaders = (backendRevision: string | undefined): HeadersInit =>
  backendRevision === undefined
    ? {}
    : { [backendRevisionHeader]: backendRevision };

const decodeRpcToken = Schema.decodeEffect(
  CampaignUnsubscribeToken.check(Schema.makeFilter(hasSignedClaimsEncoding))
);

const rpcToken = (token: string) =>
  decodeRpcToken(token).pipe(
    Effect.mapError(() => new CampaignUnsubscribeRejected())
  );

const unsubscribe = Effect.fn("emailPreferences.unsubscribe")(function* (
  request: Request
) {
  const token = linkToken(request);
  const { transport, preview } = yield* emailPreferencesBackend;
  if (transport === "local") {
    const outcome = yield* CampaignUnsubscribeService.pipe(
      Effect.flatMap((service) => service.unsubscribe(token)),
      Effect.provide(CampaignUnsubscribeService.Live)
    );
    return { outcome, backendRevision: undefined };
  }

  const validated = yield* rpcToken(token);
  const outcome = yield* withWorkspaceRpcClient(
    workspaceRpcCaller(request),
    preview,
    (client) => client.unsubscribeOneClick({ token: validated })
  );
  return { outcome, backendRevision: preview?.commitSha };
});

const preferencesUrl = Effect.fn("emailPreferences.preferencesUrl")(function* (
  request: Request
) {
  const token = linkToken(request);
  const { transport, preview } = yield* emailPreferencesBackend;
  if (transport === "local") {
    const url = yield* CampaignUnsubscribeService.pipe(
      Effect.flatMap((service) => service.preferencesUrl(token)),
      Effect.provide(CampaignUnsubscribeService.Live)
    );
    return { url, backendRevision: undefined };
  }

  const validated = yield* rpcToken(token);
  const caller = workspaceRpcCaller(request);
  const { accessToken } = yield* withWorkspaceRpcClient(
    caller,
    preview,
    (client) => client.openPreferences({ token: validated })
  );
  const url = yield* getRuntimeMarketingPreferencesAccessUrl(
    accessToken,
    caller.locale
  );
  return { url, backendRevision: preview?.commitSha };
});

/**
 * POST /api/email-campaigns/unsubscribe?token=…
 *
 * RFC 8058 one-click unsubscribe: a mail client posts
 * `List-Unsubscribe=One-Click` here, and the recipient's marketing consent is
 * withdrawn. Repeating the request succeeds without changing anything.
 */
export const POST = defineWorkspaceRoute(
  {
    operation: "emailCampaignUnsubscribe",
    cancellation: "continue-after-disconnect",
    caller: "client",
  },
  (request) =>
    unsubscribe(request).pipe(
      Effect.tap(({ outcome }) =>
        Effect.logInfo("Campaign unsubscribe processed", { outcome })
      ),
      Effect.map(({ backendRevision }) =>
        NextResponse.json(
          { status: "unsubscribed" },
          { headers: revisionHeaders(backendRevision) }
        )
      ),
      Effect.mapError((error) =>
        Match.value(error).pipe(
          Match.tag(
            "CampaignUnsubscribeTokenInvalid",
            "CampaignUnsubscribeRejected",
            invalidLink
          ),
          Match.tag("PreviewBackendUnavailable", previewUnavailable),
          Match.orElse(
            WorkspaceRouteFailure.internal(
              "Unsubscribe could not be processed."
            )
          )
        )
      )
    )
);

/**
 * GET /api/email-campaigns/unsubscribe?token=…
 *
 * Opening the link (the email footer, or a client that only follows it)
 * never unsubscribes; it opens the recipient's marketing preferences.
 */
export const GET = defineWorkspaceRoute(
  {
    operation: "emailCampaignPreferences",
    cancellation: "interrupt-on-disconnect",
    caller: "client",
  },
  (request) =>
    preferencesUrl(request).pipe(
      Effect.map(({ url, backendRevision }) =>
        NextResponse.redirect(url, {
          status: 303,
          headers: revisionHeaders(backendRevision),
        })
      ),
      Effect.mapError((error) =>
        Match.value(error).pipe(
          Match.tag(
            "CampaignUnsubscribeTokenInvalid",
            "CampaignUnsubscribeRejected",
            invalidLink
          ),
          Match.tag("PreviewBackendUnavailable", previewUnavailable),
          Match.orElse(
            WorkspaceRouteFailure.internal(
              "Marketing preferences could not be opened."
            )
          )
        )
      )
    )
);
