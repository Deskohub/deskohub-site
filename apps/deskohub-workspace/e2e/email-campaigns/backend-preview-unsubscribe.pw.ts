import "../../shared/polyfills/temporal";

import { DotyposCustomerIdSchema } from "@deskohub/dotypos";
import { loadCampaignSigningKeys } from "@deskohub/workspace-backend/features/email-campaigns/backend/campaign-signing-keys";
import { backendRevisionHeader } from "@deskohub/workspace-cloud-run/preview-generation";
import { eq } from "drizzle-orm";
import { ConfigProvider, Effect } from "effect";
import {
  customerMarketingConsents,
  customerMarketingManagementTokens,
  emailCampaignSends,
  emailCampaigns,
} from "@/db/schema";
import { seedCampaignSend } from "@/features/email-campaigns/backend/email-campaigns.test-utils";
import { signCampaignUnsubscribeToken } from "@/features/email-campaigns/campaign-unsubscribe-token";
import { runE2ECase } from "../case-runner";
import { isWorkspaceDeploymentOrigin } from "../config";
import { workspaceE2EError } from "../errors";
import { E2EDatabase } from "../integrations/database.service";
import { runtimeTest as test } from "../playwright-checkout/runtime-fixtures";
import { workspaceE2ETimeouts } from "../timeouts";

const operation = "prove backend preview email preferences";
const failure = (message: string) => workspaceE2EError(message, { operation });

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
        const { db } = yield* E2EDatabase;
        const dotyposCustomerId = DotyposCustomerIdSchema.make(
          `preview-unsubscribe-${runContext.runId}`
        );
        const { sendId } = yield* Effect.acquireRelease(
          db
            .transaction(
              Effect.fn(function* (transaction) {
                const campaign = yield* Effect.tryPromise({
                  try: () =>
                    seedCampaignSend(transaction, {
                      purpose: "marketing",
                      status: "sent",
                      recipients: [{ dotyposCustomerId, status: "delivered" }],
                    }),
                  catch: () =>
                    failure("Could not seed a synthetic campaign recipient"),
                });
                yield* transaction.insert(customerMarketingConsents).values({
                  dotyposCustomerId,
                  documentHash: "synthetic-preview-proof",
                  locale: "en-US",
                  grantedAt: Temporal.Now.instant(),
                });
                return campaign;
              })
            )
            .pipe(
              Effect.mapError(() =>
                failure("Could not seed synthetic preview consent")
              )
            ),
          ({ campaignId }) =>
            db
              .transaction(
                Effect.fn(function* (transaction) {
                  yield* transaction
                    .delete(emailCampaignSends)
                    .where(eq(emailCampaignSends.campaignId, campaignId));
                  yield* transaction
                    .delete(emailCampaigns)
                    .where(eq(emailCampaigns.id, campaignId));
                  yield* transaction
                    .delete(customerMarketingManagementTokens)
                    .where(
                      eq(
                        customerMarketingManagementTokens.dotyposCustomerId,
                        dotyposCustomerId
                      )
                    );
                  yield* transaction
                    .delete(customerMarketingConsents)
                    .where(
                      eq(
                        customerMarketingConsents.dotyposCustomerId,
                        dotyposCustomerId
                      )
                    );
                })
              )
              .pipe(
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
                yield* Effect.promise(
                  () => response.body?.cancel() ?? Promise.resolve()
                );
                if (
                  response.status !== 303 ||
                  response.headers.get(backendRevisionHeader) !== commitSha ||
                  !location?.pathname.endsWith("/marketing-preferences/access")
                ) {
                  return yield* failure(
                    "The synthetic GET did not use the expected backend revision"
                  );
                }
                const [row] = yield* consent;
                if (!row || row.withdrawnAt !== null)
                  return yield* failure("The synthetic GET changed consent");
              }).pipe(
                Effect.mapError(() =>
                  failure(
                    "Could not prove the synthetic GET against preview consent"
                  )
                )
              ),
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
              }).pipe(
                Effect.mapError(() =>
                  failure(
                    "Could not prove the synthetic POST against preview consent"
                  )
                )
              ),
            });
          }),
        });
      })
    )
  );
});
