import { expect, type Page } from "@playwright/test";
import { Effect } from "effect";
import { getAccountSectionPath } from "@/features/account/routes";
import { m } from "@/features/i18n";
import {
  getUnlimitedPassPrice,
  unlimitedPassDays,
} from "@/features/passes/pass-offer";
import { formatPassDate } from "@/features/passes/pass-offer.i18n";
import { getUnlimitedPassChoosePath } from "@/features/passes/unlimited-pass-checkout";
import { getCurrentWorkspaceDate } from "@/features/reservation/reservation-date";
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
import { openPage, waitForPageUrl, waitForReactHandler } from "../browser";
import { getWorkspaceE2EDateInterval } from "../capacity";
import { completeNexiHostedPayment } from "../checkout/nexi-hosted-payment";
import { submitPaymentAndWaitForHostedPage } from "../checkout/payment";
import { getConfig, getDatasourceConfig } from "../config";
import { WorkspaceE2EHostedPaymentPermitService } from "../coordination/hosted-payment-permit.service";
import type { WorkspaceE2EEnvironment } from "../e2e-env";
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

const locale = "en-US";
const localized = { locale } as const;
const tier = "open-space";

const renewalConsent = (page: Page) =>
  page.getByRole("checkbox", {
    name: m.unlimitedPassCheckoutAutoRenewConsent({}, localized),
    exact: true,
  });

const orderAndPay = (page: Page) =>
  page.getByRole("button", {
    name: m.checkoutPayOrderAndPayButton({}, localized),
  });

const renewalCard = (page: Page) =>
  page.getByRole("article").filter({
    has: page.getByRole("heading", {
      name: m.accountUnlimitedAutoRenewalTitle({}, localized),
      exact: true,
    }),
  });

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
  const identities = makeWorkspaceE2ECaseIdentities({
    baseUrl: config.baseUrl,
    datasourceConfig: getDatasourceConfig(environment),
    displayName: () => "Workspace E2E Unlimited Buyer",
    journalOwnerId: unlimitedPassAutoRenewalCaseId,
    runId,
    secret: resolveWorkspaceE2ESessionSigningSecret(environment),
  });
  const start = getUnlimitedPassE2EStart(allocation);
  const startDate = plainDateStringSchema.make(start.toString());
  const lastDay = start.add({ days: unlimitedPassDays - 1 });
  const renewalDate = start.add({ days: unlimitedPassDays });
  const amount = formatMoney(
    getUnlimitedPassPrice({ kind: "unlimited", tier }),
    locale
  );
  const accountUrl = new URL(
    getAccountSectionPath(locale, "passes"),
    config.baseUrl
  ).href;
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
      const account = yield* runStep({
        execute: identities.seedLinkedAccount(
          unlimitedPassAutoRenewalRecipientLabel
        ),
        id: "seed-unlimited-pass-buyer",
        timeoutMs: timeouts.datasource,
      });
      addRedaction(account.accountId);
      addRedaction(account.customerId, true);
      const session = yield* runStep({
        execute: identities
          .signIn(account, { openSession })
          .pipe(Effect.andThen(openSession)),
        id: "sign-in-unlimited-pass-buyer",
        timeoutMs: timeouts.datasource,
      });
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
          yield* waitForReactHandler(session, "main form", "onSubmit", {
            timeoutMs: timeouts.uiTransition,
          });
          yield* session.use(
            "choose automatic Unlimited renewal",
            async (page) => {
              const oneTime = page.getByRole("radio", {
                name: m.unlimitedPassCheckoutOneTime({}, localized),
              });
              const autoRenew = page.getByRole("radio", {
                name: m.unlimitedPassCheckoutAutoRenew({}, localized),
              });
              await expect(oneTime).toBeChecked({
                timeout: timeouts.browserAction,
              });
              await expect(autoRenew).not.toBeChecked();
              await autoRenew
                .filter({ visible: true })
                .check({ timeout: timeouts.browserAction });
              const next = page
                .getByRole("button", { name: continueName, exact: true })
                .filter({ visible: true });
              await expect(next).toBeEnabled({
                timeout: timeouts.providerTransition,
              });
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
            await expect(
              page.getByText(
                m.unlimitedPassCheckoutAutoRenewPreview({}, localized),
                { exact: true }
              )
            ).toBeVisible();
            await expect(consent).toBeVisible();
            await expect(consent).not.toBeChecked();
            await page
              .getByRole("checkbox", { name: /^I agree to the / })
              .filter({ visible: true })
              .check({ timeout: timeouts.browserAction });
            await expect(pay).toBeDisabled();
            await consent
              .filter({ visible: true })
              .check({ timeout: timeouts.browserAction });
            await expect(pay).toBeEnabled();
          }
        ),
        id: "give-unlimited-renewal-consent",
        timeoutMs: timeouts.uiTransition,
      });

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
            execute: completeNexiHostedPayment({
              challengeOutcome: "authenticated",
              data: account,
              hostedPaymentPage,
              session,
              timeouts,
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
            }
          );
        }),
        id: "confirm-first-unlimited-payment",
        timeoutMs: timeouts.hostedPayment,
      });

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
              await expect(
                card.getByText(
                  m.accountUnlimitedAutoRenewalPending({}, localized),
                  { exact: true }
                )
              ).toBeVisible();
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
            }
          );
        }),
        id: "stop-renewal-and-preserve-paid-period",
        timeoutMs: timeouts.checkoutStart,
      });
    }),
  };
};
