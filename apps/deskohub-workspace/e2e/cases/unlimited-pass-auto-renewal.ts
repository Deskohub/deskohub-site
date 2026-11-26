import { expect, type Page } from "@playwright/test";
import { Effect } from "effect";
import { getAccountSectionPath } from "@/features/account/routes";
import { m } from "@/features/i18n";
import { getLegalDocumentPath } from "@/features/legal/legal-document-path";
import {
  getUnlimitedPassPrice,
  unlimitedPassDays,
} from "@/features/passes/pass-offer";
import { formatPassDate } from "@/features/passes/pass-offer.i18n";
import { withPassPurchaseAddons } from "@/features/passes/pass-purchase-quote";
import { getUnlimitedPassChoosePath } from "@/features/passes/unlimited-pass-checkout";
import { getCurrentWorkspaceDate } from "@/features/reservation/reservation-date";
import { getWorkspaceAvailabilityRange } from "@/features/reservation/workspace-availability";
import { formatMoney } from "@/shared/money/money";
import {
  formatPlainDate,
  formatPlainDateRange,
} from "@/shared/utils/date-time-format";
import { formatCount } from "@/shared/utils/number";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import { makeWorkspaceE2ECaseIdentities } from "../account/case-identities";
import { resolveWorkspaceE2ESessionSigningSecret } from "../account/seeded-session";
import type { WorkspaceE2EDateAllocation } from "../allocation";
import {
  openPage,
  readPageUrl,
  waitForPageUrl,
  waitForReactHandler,
} from "../browser";
import { getWorkspaceE2EDateInterval } from "../capacity";
import { completeNexiHostedPayment } from "../checkout/nexi-hosted-payment";
import { submitPaymentAndWaitForHostedPage } from "../checkout/payment";
import { getConfig, getDatasourceConfig } from "../config";
import { WorkspaceE2EHostedPaymentPermitService } from "../coordination/hosted-payment-permit.service";
import {
  unlimitedPassReviewLocale,
  unlimitedPassWorkspaceReviewOnly,
  type WorkspaceE2EEnvironment,
} from "../e2e-env";
import { workspaceE2EError } from "../errors";
import {
  unlimitedPassAutoRenewalCaseId,
  unlimitedPassAutoRenewalRecipientLabel,
} from "../playwright-checkout/case-catalog";
import { addRedaction } from "../redaction";
import {
  recordReservationIntent,
  recordReservationResult,
} from "../reservation-intents";
import type { WorkspaceE2ERunId } from "../run-identifiers";
import type { WorkspaceE2ECase, WorkspaceE2ECaseContext } from "../types";
import { isExpectedCheckoutStatusUrl } from "../urls";
import { switchLocale } from "./locale";
import { makeUnlimitedPassReviewCapture } from "./unlimited-pass-review";

const tier = "open-space";

export const getUnlimitedPassE2EStart = (
  allocation: WorkspaceE2EDateAllocation,
  today = getCurrentWorkspaceDate()
) =>
  today.add({
    // Ordinary checkout uses only the first range. Give each leased shard
    // its own contiguous pass window and leave a gap across overnight runs.
    days:
      allocation.toOffsetDays +
      7 +
      (unlimitedPassDays + 2) * allocation.shardIndex,
  });

export const makeUnlimitedPassAutoRenewalCase = ({
  allocation,
  environment,
  runId,
}: {
  readonly allocation: WorkspaceE2EDateAllocation;
  readonly environment: WorkspaceE2EEnvironment;
  readonly runId: WorkspaceE2ERunId;
}): WorkspaceE2ECase => {
  const config = getConfig(environment);
  const { timeouts } = config;
  const reviewLocale = unlimitedPassReviewLocale(environment);
  const workspaceOnly = unlimitedPassWorkspaceReviewOnly(environment);
  const locale = reviewLocale ?? "en-US";
  const localized = { locale } as const;
  const accountPath = getAccountSectionPath(locale, "passes");
  const renewalConsent = (page: Page) =>
    page.getByRole("checkbox", {
      name: m.unlimitedPassCheckoutAutoRenewConsent({}, localized),
      exact: true,
    });
  const orderAndPay = (page: Page) =>
    page.getByRole("button", {
      name: m.checkoutPayOrderAndPayButton({}, localized),
    });
  const renewalCard = (page: Page, cardLocale = locale) =>
    page.getByRole("article").filter({
      has: page.getByRole("heading", {
        name: m.accountUnlimitedAutoRenewalTitle({}, { locale: cardLocale }),
        exact: true,
      }),
    });
  const purchaseModes = (page: Page) => ({
    autoRenew: page.getByRole("radio", {
      name: m.unlimitedPassCheckoutAutoRenew({}, localized),
    }),
    oneTime: page.getByRole("radio", {
      name: m.unlimitedPassCheckoutOneTime({}, localized),
    }),
  });
  const identities = makeWorkspaceE2ECaseIdentities({
    baseUrl: config.baseUrl,
    datasourceConfig: getDatasourceConfig(environment),
    displayName: () => "Workspace E2E Unlimited Buyer",
    journalOwnerId: unlimitedPassAutoRenewalCaseId,
    runId,
    secret: resolveWorkspaceE2ESessionSigningSecret(environment),
  });
  const today = getCurrentWorkspaceDate();
  const start = getUnlimitedPassE2EStart(allocation, today);
  const startDate = plainDateStringSchema.make(start.toString());
  const lastDay = start.add({ days: unlimitedPassDays - 1 });
  const renewalDate = start.add({ days: unlimitedPassDays });
  const amount = formatMoney(
    withPassPurchaseAddons(
      getUnlimitedPassPrice({ kind: "unlimited", tier }),
      reviewLocale !== undefined
    ),
    locale
  );
  const accountUrl = new URL(accountPath, config.baseUrl).href;
  const period = formatPlainDateRange({ start, end: lastDay, locale });
  const startsOn = m.unlimitedAccessStarts(
    { date: formatPlainDate({ date: start, locale }) },
    localized
  );
  const renewalPlan = m.accountUnlimitedAutoRenewalPlan(
    {
      amount,
      date: formatPlainDate({ date: renewalDate, locale }),
    },
    localized
  );

  return {
    checkoutStates: [],
    id: unlimitedPassAutoRenewalCaseId,
    timeoutMs: timeouts.unlimitedPassCase,
    execute: Effect.fn("E2E.unlimitedPassAutoRenewal")(function* ({
      openSession,
      runStep,
    }: WorkspaceE2ECaseContext) {
      if (config.paymentProvider !== "nexi") {
        return yield* workspaceE2EError(
          "Unlimited pass auto-renewal requires exact Nexi mode"
        );
      }
      if (
        reviewLocale &&
        !workspaceOnly &&
        Temporal.PlainDate.compare(
          renewalDate,
          getWorkspaceAvailabilityRange(today.toString()).to
        ) > 0
      ) {
        return yield* workspaceE2EError(
          "Cannot capture manual Renew with this allocated period. The pass would end beyond the Workspace booking horizon."
        );
      }
      const review =
        reviewLocale &&
        makeUnlimitedPassReviewCapture({
          accountPath,
          locale: reviewLocale,
          origin: config.baseUrl,
          timeout: timeouts.pageDiagnosticsRead,
        });
      const account = yield* runStep({
        execute: identities.seedLinkedAccount(
          unlimitedPassAutoRenewalRecipientLabel
        ),
        id: "seed-unlimited-pass-buyer",
        timeoutMs: timeouts.datasource,
      });
      addRedaction(account.accountId);
      addRedaction(account.customerId, true);
      const buyerText = [account.name, account.email, account.phone];
      const session = yield* runStep({
        execute: identities
          .signIn(account, { openSession })
          .pipe(Effect.andThen(openSession)),
        id: "sign-in-unlimited-pass-buyer",
        timeoutMs: timeouts.datasource,
      });
      const captureTerms = (
        capture: ReturnType<typeof makeUnlimitedPassReviewCapture>
      ) =>
        openPage(
          session,
          config,
          new URL(
            getLegalDocumentPath(locale, "terms-and-conditions"),
            config.baseUrl
          ).href,
          { timeoutMs: timeouts.browserAction }
        ).pipe(
          Effect.andThen(
            session.use("capture canonical Unlimited renewal terms", (page) =>
              capture.captureWorkspace(page, "terms")
            )
          )
        );
      const continueName = m.checkoutContinueButton({}, localized);
      const chooseUrl = new URL(
        getUnlimitedPassChoosePath(locale, { tier, coffee: false }, startDate),
        config.baseUrl
      ).href;
      yield* runStep({
        execute: Effect.gen(function* () {
          yield* openPage(session, config, chooseUrl, {
            timeoutMs: timeouts.browserAction,
          });
          if (workspaceOnly) {
            const activeUrl = yield* readPageUrl(session);
            if (
              URL.parse(activeUrl ?? "")?.pathname !==
              new URL(chooseUrl).pathname
            ) {
              yield* switchLocale(session, locale, timeouts);
            }
          }
          yield* waitForReactHandler(session, "main form", "onSubmit", {
            timeoutMs: timeouts.uiTransition,
          });
          yield* session.use(
            "choose automatic Unlimited renewal",
            async (page) => {
              const { autoRenew, oneTime } = purchaseModes(page);
              await expect(oneTime).toBeChecked({
                timeout: timeouts.browserAction,
              });
              await expect(autoRenew).not.toBeChecked();
              if (review) {
                await review.captureWorkspace(
                  page,
                  "choose-default",
                  buyerText
                );
                const coffee = page.getByRole("switch", {
                  name: m.unlimitedPassCheckoutCoffee(
                    { days: formatCount(unlimitedPassDays, locale) },
                    localized
                  ),
                });
                await coffee.click({ timeout: timeouts.browserAction });
                await expect(coffee).toHaveAttribute("aria-checked", "true");
              }
              await autoRenew
                .filter({ visible: true })
                .check({ timeout: timeouts.browserAction });
              const next = page
                .getByRole("button", { name: continueName, exact: true })
                .filter({ visible: true });
              await expect(next).toBeEnabled({
                timeout: timeouts.providerTransition,
              });
              await review?.captureWorkspace(page, "choose-renewal", buyerText);
              await next.click({ timeout: timeouts.browserAction });
            }
          );
        }),
        id: "choose-unlimited-auto-renewal",
        timeoutMs: timeouts.checkoutStart,
      });

      const { intent, orderId } = yield* runStep({
        execute: Effect.gen(function* () {
          yield* waitForReactHandler(
            session,
            "main form[method=post]",
            "onSubmit",
            {
              timeoutMs: timeouts.uiTransition,
            }
          );
          if (review) {
            yield* session.use("capture Unlimited buyer details", (page) =>
              review.captureWorkspace(page, "details", buyerText)
            );
          }
          const intent = yield* recordReservationIntent({
            owner: { customerId: account.customerId },
            requestedAt: new Date().toISOString(),
            ...getWorkspaceE2EDateInterval({
              fromDate: startDate,
              toDate: lastDay.toString(),
            }),
          });
          yield* session.use("submit Unlimited buyer details", (page) =>
            page
              .getByRole("button", { name: continueName, exact: true })
              .filter({ visible: true })
              .click({ timeout: timeouts.browserAction })
          );
          const orderId = yield* session.use(
            "reach Unlimited pay with renewal consent",
            async (page) => {
              await renewalConsent(page).waitFor({
                state: "visible",
                timeout: timeouts.unlimitedPassCheckoutStart,
              });
              return new URL(page.url()).searchParams.get("order");
            }
          );
          if (!orderId)
            return yield* workspaceE2EError("Unlimited pay page has no order");
          addRedaction(orderId);
          yield* recordReservationResult(intent, { orderId });
          return { intent, orderId };
        }),
        id: "hold-unlimited-period",
        timeoutMs: timeouts.unlimitedPassCheckoutStart,
      });

      yield* runStep({
        execute: session.use(
          "review Unlimited schedule and give explicit consent",
          async (page) => {
            const consent = renewalConsent(page);
            const pay = orderAndPay(page);
            const schedule = m.unlimitedPassCheckoutAutoRenewSchedule(
              {
                amount,
                date: formatPassDate(renewalDate.toString(), locale),
                days: formatCount(unlimitedPassDays, locale),
              },
              localized
            );
            await expect(
              page.getByText(schedule, { exact: true })
            ).toBeVisible();
            await expect(consent).toBeVisible();
            await expect(consent).not.toBeChecked();
            const termsName = m
              .checkoutPayConsent({}, localized)
              .split("<terms>")[0]
              ?.trim();
            await page
              .getByRole("checkbox", { name: termsName })
              .filter({ visible: true })
              .check({ timeout: timeouts.browserAction });
            const earlyStart = page
              .getByRole("checkbox", {
                name: m.unlimitedPassEarlyStartConsent({}, localized),
                exact: true,
              })
              .filter({ visible: true });
            if (await earlyStart.count()) {
              await earlyStart.check({ timeout: timeouts.browserAction });
            }
            await expect(pay).toBeDisabled();
            await review?.captureWorkspace(page, "pay-unchecked", [
              ...buyerText,
              orderId,
            ]);
            await consent
              .filter({ visible: true })
              .check({ timeout: timeouts.browserAction });
            await expect(pay).toBeEnabled();
            await review?.captureWorkspace(page, "pay-accepted", [
              ...buyerText,
              orderId,
            ]);
          }
        ),
        id: "give-unlimited-renewal-consent",
        timeoutMs: timeouts.uiTransition,
      });

      if (workspaceOnly) {
        if (!review) {
          return yield* workspaceE2EError(
            "Czech Unlimited Workspace review requires screenshot capture"
          );
        }
        yield* runStep({
          execute: Effect.gen(function* () {
            yield* captureTerms(review);
            const missing = review.missingShots([
              "choose-default",
              "choose-renewal",
              "details",
              "pay-unchecked",
              "pay-accepted",
              "terms",
            ]);
            if (missing.length) {
              return yield* workspaceE2EError(
                `Incomplete Czech Unlimited Workspace screenshots: ${missing
                  .map(({ shot, problem }) => `${shot} (${problem})`)
                  .join(", ")}`
              );
            }
          }),
          id: "capture-czech-unlimited-workspace-review",
          timeoutMs: timeouts.reviewScreenshotCapture,
        });
        // The journal owns the held period. This review never activates Pay.
        return;
      }

      const permit = yield* WorkspaceE2EHostedPaymentPermitService;
      const paymentStartedAt = yield* permit.withPermit(
        "Unlimited first hosted payment",
        Effect.gen(function* () {
          const paymentStartedAt = new Date().toISOString();
          const hostedPaymentPage = yield* runStep({
            execute: recordReservationResult(intent, {
              orderId,
              paymentStartedAt,
            }).pipe(
              Effect.andThen(
                submitPaymentAndWaitForHostedPage({
                  config,
                  observeHandoffDocument: !!review,
                  session,
                  submitPayment: (activeSession) =>
                    activeSession.use(
                      "submit consented Unlimited payment",
                      async (page) => {
                        await orderAndPay(page)
                          .filter({ visible: true })
                          .click({ timeout: timeouts.browserAction });
                        return page;
                      }
                    ),
                })
              )
            ),
            id: "open-unlimited-nexi-payment",
            timeoutMs: timeouts.providerTransition,
          });
          yield* runStep({
            execute: Effect.gen(function* () {
              if (review) {
                yield* session.use("capture empty Nexi handoff", (page) =>
                  review.captureNexi(page, hostedPaymentPage, [
                    ...buyerText,
                    orderId,
                  ])
                );
              }
              yield* completeNexiHostedPayment({
                challengeOutcome: "authenticated",
                data: account,
                hostedPaymentPage,
                session,
                timeouts,
              });
            }),
            id: "approve-first-unlimited-payment",
            timeoutMs: timeouts.hostedPayment,
          });
          return paymentStartedAt;
        })
      );

      yield* runStep({
        execute: Effect.gen(function* () {
          yield* waitForPageUrl({
            description: "return to the Unlimited purchase status",
            matches: (url) =>
              isExpectedCheckoutStatusUrl(url, config.expectedHost),
            session,
            timeoutMs: timeouts.providerTransition,
          });
          yield* session.use(
            "confirm paid Unlimited purchase",
            async (page) => {
              const path = new URL(page.url()).pathname;
              expect(
                path.endsWith(`/${orderId}`),
                "returned to the submitted order"
              ).toBe(true);
              await expect(
                page.getByRole("heading", {
                  name: m.unlimitedPassStatusPaidTitle({}, localized),
                })
              ).toBeVisible({ timeout: timeouts.providerTransition });
              await review?.captureWorkspace(
                page,
                "paid-status",
                [...buyerText, orderId],
                orderId
              );
            }
          );
        }),
        id: "confirm-first-unlimited-payment",
        timeoutMs: timeouts.hostedPayment,
      });

      const czechAccountPath = getAccountSectionPath("cs-CZ", "passes");
      const czechReview =
        reviewLocale === "en-US" &&
        makeUnlimitedPassReviewCapture({
          accountPath: czechAccountPath,
          locale: "cs-CZ",
          origin: config.baseUrl,
          timeout: timeouts.pageDiagnosticsRead,
        });
      const captureCzechAccount = Effect.fn("E2E.captureCzechUnlimitedAccount")(
        function* (
          capture: ReturnType<typeof makeUnlimitedPassReviewCapture>,
          shot: "account-renewal" | "account-stopped-after-reload"
        ) {
          const czech = { locale: "cs-CZ" } as const;
          yield* switchLocale(session, czech.locale, timeouts).pipe(
            Effect.andThen(
              session.use(
                "verify and capture Czech Unlimited Account",
                async (page) => {
                  await page.waitForURL(
                    (url) => url.pathname === czechAccountPath,
                    {
                      timeout: timeouts.browserNavigation,
                    }
                  );
                  const card = renewalCard(page, czech.locale);
                  const czechPeriod = formatPlainDateRange({
                    start,
                    end: lastDay,
                    ...czech,
                  });
                  await expect(
                    card.getByText(czechPeriod, { exact: true })
                  ).toBeVisible();
                  if (shot === "account-renewal") {
                    await expect(
                      card.getByRole("button", {
                        name: m.accountUnlimitedAutoRenewalCancel({}, czech),
                        exact: true,
                      })
                    ).toBeVisible();
                  } else {
                    await expect(
                      card.getByText(
                        m.accountUnlimitedAutoRenewalStopped({}, czech),
                        {
                          exact: true,
                        }
                      )
                    ).toBeVisible();
                  }
                  await capture.captureWorkspace(page, shot, [
                    ...buyerText,
                    orderId,
                  ]);
                }
              )
            ),
            Effect.ignore
          );
          const activeUrl = yield* readPageUrl(session);
          if (URL.parse(activeUrl ?? "")?.pathname.startsWith("/cs-CZ/")) {
            yield* switchLocale(session, "en-US", timeouts);
          }
          yield* openPage(session, config, accountUrl, {
            timeoutMs: timeouts.browserAction,
          });
        }
      );

      yield* runStep({
        execute: Effect.gen(function* () {
          yield* openPage(session, config, accountUrl, {
            timeoutMs: timeouts.browserAction,
          });
          yield* session.use(
            "verify paid Unlimited period and renewal intent",
            async (page) => {
              const card = renewalCard(page);
              await expect(
                card.getByText(renewalPlan, { exact: true })
              ).toBeVisible({ timeout: timeouts.providerTransition });
              await expect(
                card.getByText(period, { exact: true })
              ).toBeVisible();
              await expect(
                card.getByText(startsOn, { exact: true })
              ).toBeVisible();
              await review?.captureWorkspace(page, "account-renewal", [
                ...buyerText,
                orderId,
              ]);
            }
          );
          yield* recordReservationResult(intent, {
            orderId,
            paymentStartedAt,
            paymentFulfilledAt: new Date().toISOString(),
          });
        }),
        id: "read-unlimited-renewal-in-account",
        timeoutMs: timeouts.hostedPayment,
      });

      if (czechReview) {
        yield* runStep({
          execute: captureCzechAccount(czechReview, "account-renewal"),
          id: "capture-czech-unlimited-account-renewal",
          timeoutMs: timeouts.checkoutStart,
        });
      }

      yield* runStep({
        execute: Effect.gen(function* () {
          yield* waitForReactHandler(session, "article button", "onClick", {
            timeoutMs: timeouts.uiTransition,
          });
          yield* session.use(
            "stop Unlimited renewal from Account",
            async (page) => {
              const stop = page.getByRole("button", {
                name: m.accountUnlimitedAutoRenewalCancel({}, localized),
                exact: true,
              });
              await stop
                .filter({ visible: true })
                .click({ timeout: timeouts.browserAction });
              await expect(
                page.getByText(
                  m.accountUnlimitedAutoRenewalStopped({}, localized),
                  { exact: true }
                )
              ).toBeVisible({ timeout: timeouts.uiTransition });
              await review?.captureWorkspace(page, "account-stop-confirmed", [
                ...buyerText,
                orderId,
              ]);
            }
          );
          yield* openPage(session, config, accountUrl, {
            timeoutMs: timeouts.browserAction,
          });
          yield* session.use(
            "verify stopped renewal and unchanged paid access after reload",
            async (page) => {
              const card = renewalCard(page);
              await expect(
                card.getByText(
                  m.accountUnlimitedAutoRenewalStopped({}, localized),
                  { exact: true }
                )
              ).toBeVisible({ timeout: timeouts.uiTransition });
              await expect(
                card.getByText(period, { exact: true })
              ).toBeVisible();
              await expect(
                card.getByText(startsOn, { exact: true })
              ).toBeVisible();
              await expect(
                card.getByText(renewalPlan, { exact: true })
              ).toHaveCount(0);
              await expect(
                card.getByRole("button", {
                  name: m.accountUnlimitedAutoRenewalCancel({}, localized),
                })
              ).toHaveCount(0);
              await review?.captureWorkspace(
                page,
                "account-stopped-after-reload",
                [...buyerText, orderId]
              );
            }
          );
        }),
        id: "stop-renewal-and-preserve-paid-period",
        timeoutMs: timeouts.checkoutStart,
      });

      if (czechReview) {
        yield* runStep({
          execute: captureCzechAccount(
            czechReview,
            "account-stopped-after-reload"
          ),
          id: "capture-czech-unlimited-account-stopped",
          timeoutMs: timeouts.checkoutStart,
        });
      }

      if (review) {
        yield* runStep({
          execute: Effect.gen(function* () {
            yield* session.use(
              "open the existing manual Renew link",
              async (page) => {
                const renew = renewalCard(page).getByRole("link", {
                  name: m.unlimitedPassRenew({}, localized),
                });
                if (!(await renew.isVisible())) return;
                await renew.click({ timeout: timeouts.browserAction });
                const { autoRenew, oneTime } = purchaseModes(page);
                await expect(oneTime).toBeChecked({
                  timeout: timeouts.browserAction,
                });
                await expect(autoRenew).not.toBeChecked();
                const selectedDay = page
                  .locator(`[data-day="${renewalDate}"][data-selected="true"]`)
                  .filter({ visible: true });
                await expect(selectedDay).toBeVisible();
                await review.captureWorkspace(page, "manual-renew", [
                  ...buyerText,
                  orderId,
                ]);
              }
            );
            yield* captureTerms(review);
            const missingShots = [
              ...review
                .missingShots()
                .map((missing) => ({ ...missing, locale })),
              ...(czechReview
                ? czechReview
                    .missingShots([
                      "account-renewal",
                      "account-stopped-after-reload",
                    ])
                    .map((missing) => ({ ...missing, locale: "cs-CZ" }))
                : []),
            ];
            if (missingShots.length) {
              return yield* workspaceE2EError(
                `Incomplete Unlimited review screenshots: ${missingShots
                  .map(
                    ({ locale, shot, problem }) =>
                      `${locale}/${shot} (${problem})`
                  )
                  .join(", ")}`
              );
            }
          }),
          id: "capture-unlimited-renewal-review",
          timeoutMs: timeouts.reviewScreenshotCapture,
        });
      }
    }),
  };
};
