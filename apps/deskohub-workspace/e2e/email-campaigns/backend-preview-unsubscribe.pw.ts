import "../../shared/polyfills/temporal";

import { DotyposCustomerIdSchema } from "@deskohub/dotypos";
import { loadCampaignSigningKeys } from "@deskohub/workspace-backend/features/email-campaigns/backend/campaign-signing-keys";
import { MarketingConsentLedger } from "@deskohub/workspace-backend/features/legal/backend/marketing-consent-ledger";
import { backendRevisionHeader } from "@deskohub/workspace-cloud-run/preview-generation";
import { eq } from "drizzle-orm";
import { ConfigProvider, Effect, Layer } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import {
  customerMarketingConsents,
  customerMarketingManagementTokens,
  emailCampaignSends,
  emailCampaigns,
} from "@/db/schema";
import { insertCampaignSendFixture } from "@/features/email-campaigns/backend/email-campaigns.test-utils";
import { signCampaignUnsubscribeToken } from "@/features/email-campaigns/campaign-unsubscribe-token";
import { runE2ECase } from "../case-runner";
import { isWorkspaceDeploymentOrigin } from "../config";
import { workspaceE2EError } from "../errors";
import { E2EDatabase } from "../integrations/database.service";
import { runtimeTest as test } from "../playwright-checkout/runtime-fixtures";
import { workspaceE2ETimeouts } from "../timeouts";

const operation = "prove backend preview email preferences";
const failure = (message: string) => workspaceE2EError(message, { operation });
const previewFixtureDatabase = Layer.effect(
  WorkspaceDatabase,
  Effect.map(E2EDatabase, ({ db }) => WorkspaceDatabase.make(db))
);

test("uses the expected backend revision for the synthetic unsubscribe GET and POST", async ({
  baseURL,
  environment,
  runContext,
  runEffect,
}) => {
  test.skip(
    !environment.WORKSPACE_E2E_BACKEND_PREVIEW_REVISION,
    "Only the approved backend preview runs this proof"
  );
  const {
    TARGET_SHA: commitSha,
    VERCEL_AUTOMATION_BYPASS_SECRET: bypass,
    WORKSPACE_E2E_BETTER_AUTH_SECRETS: signing,
  } = environment;
  if (
    !baseURL ||
    !isWorkspaceDeploymentOrigin(baseURL) ||
    !commitSha ||
    !bypass ||
    !signing
  ) {
    throw failure("Missing protected preview proof configuration");
  }
  await runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const { db, transaction } = yield* WorkspaceDatabase;
        const dotyposCustomerId = DotyposCustomerIdSchema.make(
          `preview-unsubscribe-${runContext.runId}`
        );
        const { sendId } = yield* Effect.acquireRelease(
          transaction(
            Effect.gen(function* () {
              const campaign = yield* insertCampaignSendFixture(db, {
                purpose: "marketing",
                status: "sent",
                recipients: [{ dotyposCustomerId, status: "delivered" }],
              });
              yield* MarketingConsentLedger.use((ledger) =>
                ledger.record({
                  customerId: dotyposCustomerId,
                  choice: "grant",
                  mode: "initial",
                  channel: "link",
                  documentHash: "synthetic-preview-proof",
                  locale: "en-US",
                })
              ).pipe(Effect.provide(MarketingConsentLedger.Default));
              return campaign;
            })
          ).pipe(
            Effect.mapError(() =>
              failure("Could not seed synthetic preview consent")
            )
          ),
          ({ campaignId }) =>
            transaction(
              Effect.gen(function* () {
                yield* db
                  .delete(emailCampaignSends)
                  .where(eq(emailCampaignSends.campaignId, campaignId));
                yield* db
                  .delete(emailCampaigns)
                  .where(eq(emailCampaigns.id, campaignId));
                yield* db
                  .delete(customerMarketingManagementTokens)
                  .where(
                    eq(
                      customerMarketingManagementTokens.dotyposCustomerId,
                      dotyposCustomerId
                    )
                  );
                yield* db
                  .delete(customerMarketingConsents)
                  .where(
                    eq(
                      customerMarketingConsents.dotyposCustomerId,
                      dotyposCustomerId
                    )
                  );
              })
            ).pipe(
              Effect.mapError(() =>
                failure("Could not remove synthetic preview proof data")
              ),
              Effect.orDie
            )
        );

        const signingKeys = yield* loadCampaignSigningKeys(
          "unsubscribe-token"
        ).pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnvRecord({ BETTER_AUTH_SECRETS: signing })
          )
        );
        const token = yield* signCampaignUnsubscribeToken(signingKeys, {
          sendId,
          dotyposCustomerId,
        });
        const url = new URL("/api/email-campaigns/unsubscribe", baseURL);
        url.searchParams.set("token", token);

        const invoke = (method: "GET" | "POST") =>
          Effect.tryPromise({
            try: (signal) =>
              fetch(url, {
                method,
                headers: {
                  "x-vercel-protection-bypass": bypass,
                  "content-type": "application/x-www-form-urlencoded",
                },
                body:
                  method === "POST" ? "List-Unsubscribe=One-Click" : undefined,
                redirect: "manual",
                signal,
              }),
            catch: () => failure("The protected unsubscribe request failed"),
          });
        const consent = db
          .select({ withdrawnAt: customerMarketingConsents.withdrawnAt })
          .from(customerMarketingConsents)
          .where(
            eq(customerMarketingConsents.dotyposCustomerId, dotyposCustomerId)
          )
          .pipe(
            Effect.mapError(() =>
              failure("Could not read synthetic preview consent")
            )
          );

        yield* runE2ECase({
          caseId: "backend-preview-unsubscribe",
          watchdogMs: workspaceE2ETimeouts.emailCampaignCase,
          body: Effect.fn(function* (step) {
            yield* step({
              id: "open-email-preferences-over-preview-rpc",
              timeoutMs: workspaceE2ETimeouts.uiTransition,
              execute: Effect.gen(function* () {
                const response = yield* invoke("GET");
                const location = URL.parse(
                  response.headers.get("location") ?? "",
                  baseURL
                );
                const accessToken = location?.searchParams.get("token");
                yield* Effect.promise(
                  () => response.body?.cancel() ?? Promise.resolve()
                );
                if (
                  response.status !== 303 ||
                  response.headers.get(backendRevisionHeader) !== commitSha ||
                  location?.origin !== url.origin ||
                  !location.pathname.endsWith(
                    "/marketing-preferences/access"
                  ) ||
                  !accessToken ||
                  accessToken === token
                ) {
                  return yield* failure(
                    "The synthetic GET did not use the expected backend revision"
                  );
                }
                const [row] = yield* consent;
                if (!row || row.withdrawnAt !== null)
                  return yield* failure("The synthetic GET changed consent");
              }),
            });
            yield* step({
              id: "withdraw-synthetic-consent-over-preview-rpc",
              timeoutMs: workspaceE2ETimeouts.uiTransition,
              execute: Effect.gen(function* () {
                const response = yield* invoke("POST");
                yield* Effect.promise(
                  () => response.body?.cancel() ?? Promise.resolve()
                );
                if (
                  response.status !== 200 ||
                  response.headers.get(backendRevisionHeader) !== commitSha
                ) {
                  return yield* failure(
                    "The synthetic POST did not use the expected backend revision"
                  );
                }
                const [row] = yield* consent;
                if (!row?.withdrawnAt)
                  return yield* failure(
                    "The synthetic POST did not withdraw preview consent"
                  );
              }),
            });
          }),
        });
      })
    ).pipe(Effect.provide(previewFixtureDatabase))
  );
});
