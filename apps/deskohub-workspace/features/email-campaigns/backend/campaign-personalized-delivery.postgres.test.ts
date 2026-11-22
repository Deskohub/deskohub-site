import "@/shared/testing/workspace-test-env";

import { afterAll, describe, expect, test } from "bun:test";
import { DotyposCustomerIdSchema } from "@deskohub/dotypos";
import { DotyposServiceMock } from "@deskohub/dotypos/backend/service.mock";
import { makeInMemoryDotypos } from "@deskohub/dotypos/testing";
import {
  EmailDeliveryIdSchema,
  type EmailMessage,
  EmailServiceError,
  EmailServiceTag,
  NetworkError,
} from "@deskohub/email";
import { testEmailAddress } from "@deskohub/test-email";
import { EmailDraft } from "@deskohub/workspace-admin-api";
import { NodeCrypto } from "@effect/platform-node";
import { Effect, Exit, Layer, Logger, Schema } from "effect";
import { TestClock } from "effect/testing";
import { WorkspaceDatabase } from "@/db/database.service";
import {
  customerMarketingConsents,
  discountProductTargets,
  discounts,
} from "@/db/schema";
import { canonicalPromotionCodeSchema } from "@/features/discounts/contracts";
import { DiscountDefinitionRepository } from "@/features/discounts/discount-definition.repository";
import { storedDiscountIdSchema } from "@/features/discounts/persistence-contracts";
import { PromotionCodeRepository } from "@/features/discounts/promotion-code.repository";
import { PromotionCodeProvider } from "@/features/discounts/promotion-code-provider.service";
import { EmailPersistence } from "@/features/emails/backend";
import {
  CustomerValues,
  CustomerValueUnavailable,
} from "@/features/emails/values/customer";
import { EmailPreparationRetry } from "@/features/emails/values/preparation";
import type { Locale } from "@/features/i18n";
import { createWorkspacePostgresSuiteDatabase } from "@/shared/testing/workspace-postgres-test-database.test-utils";
import { campaignDeliveryPayloadHash } from "../campaign-delivery-batches";
import { CampaignService } from "./campaign.service";
import { CampaignAudienceService } from "./campaign-audience.service";
import { CampaignConfirmationCodeService } from "./campaign-confirmation-code.service";
import { campaignDeliveryTestLayer } from "./campaign-delivery.test-utils";
import { CampaignEmailConfig } from "./campaign-email.config";
import { CampaignRecipientService } from "./campaign-recipient.service";
import { CampaignSendService } from "./campaign-send.service";
import {
  type CampaignDeliveryAttempt,
  CampaignSendQueueService,
} from "./campaign-send-queue.service";
import { processCampaignSendMessage } from "./campaign-send-queue-consumer";
import { everyoneFilter } from "./email-campaigns.test-utils";
import { OnceCampaignLifecycle } from "./once-campaign-lifecycle";

const database = await createWorkspacePostgresSuiteDatabase("campaign_offers");
afterAll(async () => database?.close());

const invite =
  "https://workspace.deskohub.cz/en-US/reservation/cowork?entryTier=open-space";
const sender = testEmailAddress("campaigns");
const adminInbox = testEmailAddress("admin");
const primary = ["first", "second"] as const;

const bookingCode = (message: EmailMessage | undefined) => {
  const href = message?.html?.match(
    /href="(https:\/\/workspace\.deskohub\.cz\/en-US\/reservation\/cowork\?[^"]+)"/
  )?.[1];
  return URL.parse(href?.replaceAll("&amp;", "&") ?? "")?.searchParams.get(
    "discountCode"
  );
};

describe.skipIf(!database)("one-off campaigns with a published offer", () => {
  if (!database) return;
  const { db, pool } = database;
  const promotionCodes = PromotionCodeProvider.Default.pipe(
    Layer.provide(
      Layer.mergeAll(
        DiscountDefinitionRepository.Default,
        PromotionCodeRepository.Default
      )
    ),
    Layer.provide(database.layer)
  );
  const validatesAtCheckout = (
    code: string,
    customer: Parameters<typeof DotyposCustomerIdSchema.make>[0],
    at: Temporal.Instant
  ) =>
    Effect.runPromiseExit(
      Effect.gen(function* () {
        yield* TestClock.setTime(at.epochMilliseconds);
        const provider = yield* PromotionCodeProvider;
        return yield* provider.revalidate({
          discountableSubtotal: { value: 10_000, exponent: 2, currency: "CZK" },
          dotyposCustomerId: DotyposCustomerIdSchema.make(customer),
          firstServiceDate: at
            .toZonedDateTimeISO("Europe/Prague")
            .toPlainDate()
            .toString(),
          locale: "en-US",
          product: { kind: "cowork", tier: "basic" },
          submittedCode: canonicalPromotionCodeSchema.make(code),
        });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(promotionCodes, TestClock.layer(), Logger.layer([]))
        )
      )
    );
  const setup = async (tag: string, includeCustomerValue = false) => {
    const now = Temporal.Now.instant();
    const recipients = [...primary, "withdrawn", "untranslated"].map(
      (name) => ({
        dotyposCustomerId: DotyposCustomerIdSchema.make(`${tag}-${name}`),
        email: testEmailAddress(`${tag}-${name}`),
        locale: (name === "untranslated" ? "hi-IN" : "en-US") satisfies Locale,
      })
    );
    const dotypos = makeInMemoryDotypos({
      customers: recipients.map(({ dotyposCustomerId, email }) => ({
        id: dotyposCustomerId,
        email,
        _cloudId: "test",
        display: true,
        flags: "0",
        points: "0",
        deleted: false,
      })),
    });
    await Effect.runPromise(
      db.insert(customerMarketingConsents).values(
        recipients.map(({ dotyposCustomerId, locale }) => ({
          dotyposCustomerId,
          documentHash: "synthetic",
          locale,
          grantedAt: now,
          withdrawnAt: null,
        }))
      )
    );
    const testMessages: EmailMessage[] = [];
    const requests: {
      readonly key: string;
      readonly replay: boolean;
      readonly messages: readonly EmailMessage[];
    }[] = [];
    let attempt: CampaignDeliveryAttempt | undefined;
    let answer: "accept" | "interrupt" | "refuse" | "opaque-refusal" = "accept";
    let customerValuesAvailable = true;
    let sendPaused:
      | {
          readonly called: PromiseWithResolvers<void>;
          readonly resume: PromiseWithResolvers<void>;
        }
      | undefined;
    const acceptance = (id: string) => ({
      id: EmailDeliveryIdSchema.make(`${tag}-${id}`),
      status: "sent" as const,
      provider: "test",
      timestamp: new Date(),
    });
    const email = Layer.succeed(EmailServiceTag, {
      send: (message) =>
        Effect.sync(() => {
          testMessages.push(message);
          return acceptance("synthetic-test");
        }),
      sendBatch: (messages, options) =>
        Effect.suspend(() => {
          requests.push({
            key: options.idempotencyKey,
            messages,
            replay: options.replay ?? false,
          });
          if (sendPaused) {
            const { called, resume } = sendPaused;
            called.resolve();
            return Effect.promise(() => resume.promise).pipe(
              Effect.as(
                messages.map((_, index) => acceptance(`synthetic-${index}`))
              )
            );
          }
          if (answer === "interrupt")
            return Effect.fail(
              new NetworkError({ message: "Synthetic interruption" })
            );
          if (answer === "refuse")
            return Effect.fail(
              new EmailServiceError("Synthetic refusal", undefined, "test", {
                definitivelyUnsent: true,
                code: "synthetic-refusal",
              })
            );
          if (answer === "opaque-refusal")
            return Effect.succeed(
              messages.map(() => ({
                status: "failed" as const,
                provider: "test",
                timestamp: new Date(),
                error: new EmailServiceError(
                  "Synthetic final fallback refusal",
                  undefined,
                  "test",
                  {
                    definitivelyUnsent: true,
                    code: "synthetic-refusal",
                  }
                ),
              }))
            );
          return Effect.succeed(
            messages.map((_, index) => acceptance(`synthetic-${index}`))
          );
        }),
    });
    const config = Layer.succeed(CampaignEmailConfig, {
      deploymentEnvironment: "preview",
      from: { email: sender },
      replyTo: { email: sender },
      adminInbox,
    });
    const sending = Layer.mergeAll(
      CampaignService.Default,
      CampaignAudienceService.Default,
      EmailPersistence.Default,
      CampaignSendService.Default.pipe(
        Layer.provide(
          Layer.mergeAll(
            CampaignService.Default,
            CampaignAudienceService.Default,
            CampaignConfirmationCodeService.Default.pipe(
              Layer.provide(NodeCrypto.layer)
            ),
            Layer.mock(CampaignRecipientService, {
              resolve: ({ purpose }) =>
                Effect.sync(() => {
                  expect(purpose).toBe("marketing");
                  return { recipients, exclusions: [], duplicates: [] };
                }),
            }),
            config,
            email,
            Layer.succeed(CampaignSendQueueService, {
              enqueue: (queued) =>
                Effect.sync(() => {
                  attempt = queued;
                }),
            })
          )
        )
      )
    ).pipe(Layer.provideMerge(Logger.layer([])), Layer.provide(database.layer));
    const delivery = campaignDeliveryTestLayer(
      Layer.mergeAll(
        config,
        email,
        DotyposServiceMock({
          getCustomersByIds: dotypos.service.getCustomersByIds,
        })
      ),
      undefined,
      Layer.succeed(CustomerValues, {
        resolve: () =>
          customerValuesAvailable
            ? Effect.succeed("Sample Customer")
            : Effect.fail(new CustomerValueUnavailable({ source: "profile" })),
      })
    ).pipe(Layer.provideMerge(Logger.layer([])), Layer.provide(database.layer));
    const discountId = storedDiscountIdSchema.make(crypto.randomUUID());
    await Effect.runPromise(
      db.insert(discounts).values({
        id: discountId,
        labels: { "cs-CZ": "Sleva na coworking", "en-US": "Cowork offer" },
        percentageBasisPoints: 2500,
      })
    );
    await Effect.runPromise(
      db.insert(discountProductTargets).values({
        discountId,
        productTarget: { kind: "cowork" },
      })
    );
    const campaign = await Effect.runPromise(
      Effect.gen(function* () {
        const emails = yield* EmailPersistence;
        const reusable = yield* emails.create({
          title: "Synthetic cowork offer",
          draft: Schema.decodeUnknownSync(EmailDraft)({
            purpose: "marketing",
            templateKey: "workspace",
            structure: [
              {
                _tag: "Offer",
                id: "offer",
                value: "offer",
                labelKey: "book",
                href: invite,
                prefillDiscountCode: true,
              },
            ],
            translations: {
              "cs-CZ": {
                subject: [
                  { _tag: "Text", text: "Ukázková nabídka coworkingu" },
                ],
                texts: {
                  book: [{ _tag: "Text", text: "Rezervovat coworking" }],
                },
              },
              "en-US": {
                subject: [{ _tag: "Text", text: "Synthetic cowork offer" }],
                ...(includeCustomerValue && {
                  preheader: [{ _tag: "Value", name: "customer" }],
                }),
                texts: { book: [{ _tag: "Text", text: "Book coworking" }] },
              },
            },
            values: [
              {
                name: "offer",
                source: {
                  kind: "discount",
                  discountId,
                  validDays: 30,
                  maxUses: 1,
                  maxUsesPerCustomer: 1,
                },
              },
              ...(includeCustomerValue
                ? [
                    {
                      name: "customer",
                      source: {
                        kind: "customer",
                        path: ["profile", "customer", "displayName"],
                      },
                    },
                  ]
                : []),
            ],
          }),
        });
        yield* emails.publish(reusable.id);
        const audiences = yield* CampaignAudienceService;
        const audience = yield* audiences.create({
          title: "Synthetic audience",
          filter: everyoneFilter,
        });
        return yield* (yield* CampaignService).create({
          title: "Synthetic campaign",
          emailId: reusable.id,
          purpose: "marketing",
          templateKey: "workspace",
          audienceId: audience.id,
          content: {},
        });
      }).pipe(Effect.provide(sending))
    );
    await Effect.runPromise(
      Effect.flatMap(CampaignSendService, (sends) =>
        sends.testSend({ campaignId: campaign.id, extraRecipients: [] })
      ).pipe(Effect.provide(sending))
    );
    const sample = testMessages.find(
      ({ subject }) => subject === "[TEST] Synthetic cowork offer"
    );
    expect(sample?.subject).toBe("[TEST] Synthetic cowork offer");
    expect(bookingCode(sample)).toBe("SAMPLE CODE");
    const issuedBefore = await pool.query(
      "select 1 from discount_codes where discount_id = $1",
      [discountId]
    );
    expect(issuedBefore.rowCount).toBe(0);
    const confirmationCode = sample?.text?.match(/: ([A-Z2-9]{8})\b/)?.[1];
    if (!confirmationCode)
      throw new Error("The test message did not carry a confirmation code");
    const { sendId } = await Effect.runPromise(
      Effect.flatMap(CampaignSendService, (sends) =>
        sends.send({ campaignId: campaign.id, confirmationCode })
      ).pipe(Effect.provide(sending))
    );
    await pool.query(
      "update customer_marketing_consents set withdrawn_at = now() where dotypos_customer_id = $1",
      [recipients[2]!.dotyposCustomerId]
    );
    return {
      recipients,
      sendId,
      requests,
      answerWith: (next: typeof answer) => {
        answer = next;
      },
      setCustomerValuesAvailable: (available: boolean) => {
        customerValuesAvailable = available;
      },
      pauseDelivery: () => {
        const pause = {
          called: Promise.withResolvers<void>(),
          resume: Promise.withResolvers<void>(),
        };
        sendPaused = pause;
        return {
          called: pause.called.promise,
          resume: () => pause.resume.resolve(),
        };
      },
      deliver: () => {
        if (!attempt) throw new Error("No campaign delivery was queued");
        return Effect.runPromiseExit(
          processCampaignSendMessage(attempt).pipe(
            Effect.provide(delivery),
            Effect.provideService(EmailPreparationRetry, {
              retries: 0,
              baseDelay: 0,
            })
          )
        );
      },
      retry: (includeUnconfirmed = true) =>
        Effect.runPromiseExit(
          Effect.flatMap(CampaignSendService, (sends) =>
            sends.retryUndelivered({
              campaignId: campaign.id,
              includeUnconfirmed,
            })
          ).pipe(Effect.provide(sending))
        ),
      abandon: () =>
        Effect.runPromise(
          Effect.flatMap(WorkspaceDatabase, ({ transaction }) =>
            transaction(
              OnceCampaignLifecycle.abandon({
                campaignId: campaign.id,
                sendId,
                deliveryAttempt: 1,
                now: Temporal.Now.instant(),
              })
            )
          ).pipe(Effect.provide(Layer.merge(database.layer, Logger.layer([]))))
        ),
      staleWrite: () =>
        pool
          .query("update email_campaigns set content = $2 where id = $1", [
            campaign.id,
            { "en-US": { subject: "Old inline content" } },
          ])
          .then(
            () => undefined,
            (cause: { code?: string }) => cause.code
          ),
      publishLater: () =>
        pool.query(
          `insert into email_versions (email_id, version_number, document, required_value_names)
           select email_id, version_number + 1,
             jsonb_set(document, '{translations,en-US,subject,0,text}', to_jsonb('Later publication'::text)),
             required_value_names from email_versions where email_id = $1`,
          [campaign.emailId]
        ),
      issued: () =>
        pool.query<{
          enabled: boolean;
          restricted: boolean;
          valid_window: boolean;
        }>(
          `select c.enabled, c.max_uses = 1 and c.max_uses_per_customer = 1 and exists (
           select 1 from discount_code_customers a
           where a.code_id = c.id and a.dotypos_customer_id = p.dotypos_customer_id
         ) as restricted, c.valid_until between c.created_at + interval '29 days 23 hours' and c.created_at + interval '30 days 1 hour' as valid_window
         from email_preparations p join email_discount_issuances i on i.preparation_id = p.id
         join discount_codes c on c.code = i.code where p.send_id = $1`,
          [sendId]
        ),
      issuanceIdentity: async () => {
        const { rows } = await pool.query(
          "select i.code, i.expires_at from email_discount_issuances i join email_preparations p on p.id = i.preparation_id where p.send_id = $1 order by p.dotypos_customer_id",
          [sendId]
        );
        return JSON.stringify(rows);
      },
    };
  };

  test("test mail issues nothing; real recipients get distinct codes and replay identical messages", async () => {
    const run = await setup("replay");
    expect(await run.staleWrite()).toBe("23514");
    await run.publishLater();
    run.answerWith("interrupt");
    expect(Exit.isFailure(await run.deliver())).toBe(true);
    run.answerWith("accept");
    expect(Exit.isSuccess(await run.deliver())).toBe(true);
    const [first, replay] = run.requests;
    expect(first?.messages.length).toBe(2);
    expect(
      first?.messages.every(
        ({ subject }) => subject === "Synthetic cowork offer"
      )
    ).toBe(true);
    expect(replay?.replay).toBe(true);
    expect(replay?.key === first?.key).toBe(true);
    expect(
      campaignDeliveryPayloadHash(first?.messages ?? []) ===
        campaignDeliveryPayloadHash(replay?.messages ?? [])
    ).toBe(true);
    const codes = first?.messages.map(bookingCode) ?? [];
    expect(codes.every((code) => Boolean(code && code !== "SAMPLE CODE"))).toBe(
      true
    );
    expect(new Set(codes).size).toBe(2);
    const now = Temporal.Now.instant();
    const code = codes[0];
    if (!code) throw new Error("The first booking link did not contain a code");
    const owner = run.recipients[0]!.dotyposCustomerId;
    const other = run.recipients[1]!.dotyposCustomerId;
    expect(Exit.isSuccess(await validatesAtCheckout(code, owner, now))).toBe(
      true
    );
    expect(Exit.isFailure(await validatesAtCheckout(code, other, now))).toBe(
      true
    );
    expect(
      Exit.isFailure(
        await validatesAtCheckout(code, owner, now.add({ hours: 31 * 24 }))
      )
    ).toBe(true);
    const issued = await run.issued();
    expect(issued.rows).toEqual([
      { enabled: true, restricted: true, valid_window: true },
      { enabled: true, restricted: true, valid_window: true },
    ]);
    const skipped = await pool.query<{ skip_reason: string }>(
      "select skip_reason from email_campaign_recipients where send_id = $1 and status = 'skipped' order by skip_reason",
      [run.sendId]
    );
    expect(skipped.rows.map(({ skip_reason }) => skip_reason)).toEqual([
      "consent-withdrawn",
      "missing-email-language",
    ]);
  });

  test("a definitive first refusal disables codes and ends retry for those recipients", async () => {
    const run = await setup("refusal");
    run.answerWith("refuse");
    expect(Exit.isSuccess(await run.deliver())).toBe(true);
    const issued = await run.issued();
    expect(issued.rows.map(({ enabled }) => enabled)).toEqual([false, false]);
    expect(Exit.isFailure(await run.retry())).toBe(true);
    expect(run.requests.length).toBe(1);
  });

  test("a final per-recipient refusal can hide an uncertain fallback and keeps codes active", async () => {
    const run = await setup("fallback");
    run.answerWith("opaque-refusal");
    expect(Exit.isSuccess(await run.deliver())).toBe(true);
    expect((await run.issued()).rows.map(({ enabled }) => enabled)).toEqual([
      true,
      true,
    ]);
    expect(Exit.isFailure(await run.retry(false))).toBe(true);
  });

  test("an unresolved attempt keeps codes active through replay refusal and a later retry refusal", async () => {
    const run = await setup("uncertain");
    run.answerWith("interrupt");
    expect(Exit.isFailure(await run.deliver())).toBe(true);
    run.answerWith("refuse");
    expect(Exit.isSuccess(await run.deliver())).toBe(true);
    expect(Exit.isSuccess(await run.retry())).toBe(true);
    expect(Exit.isSuccess(await run.deliver())).toBe(true);
    expect((await run.issued()).rows.map(({ enabled }) => enabled)).toEqual([
      true,
      true,
    ]);
    expect(run.requests.map(({ replay }) => replay)).toEqual([
      false,
      true,
      false,
    ]);
    const hashes = run.requests.map(({ messages }) =>
      campaignDeliveryPayloadHash(messages)
    );
    expect(new Set(hashes).size).toBe(1);
  });

  test("temporary value failure preserves the already issued code and expiry for retry", async () => {
    const run = await setup("temporary", true);
    run.setCustomerValuesAvailable(false);
    expect(Exit.isSuccess(await run.deliver())).toBe(true);
    expect(run.requests.length).toBe(0);
    expect((await run.issued()).rows.map(({ enabled }) => enabled)).toEqual([
      true,
      true,
    ]);
    const issued = await run.issuanceIdentity();
    run.setCustomerValuesAvailable(true);
    expect(Exit.isSuccess(await run.retry())).toBe(true);
    expect(Exit.isSuccess(await run.deliver())).toBe(true);
    expect(run.requests[0]?.messages.length).toBe(2);
    expect((await run.issuanceIdentity()) === issued).toBe(true);
  });

  test("a competing delivery cannot issue a second set of codes or request a second batch", async () => {
    const run = await setup("competing");
    const paused = run.pauseDelivery();
    const delivering = run.deliver();
    try {
      await Promise.race([
        paused.called,
        delivering.then(() => {
          throw new Error("Delivery exited before reaching the provider");
        }),
      ]);
      expect(Exit.isFailure(await run.deliver())).toBe(true);
    } finally {
      paused.resume();
      await delivering;
    }
    expect(run.requests.length).toBe(1);
    expect((await run.issued()).rowCount).toBe(2);
  });

  test("an abandoned requested batch requires explicit retry of uncertain delivery", async () => {
    const run = await setup("abandoned");
    run.answerWith("interrupt");
    expect(Exit.isFailure(await run.deliver())).toBe(true);
    await run.abandon();
    expect(Exit.isFailure(await run.retry(false))).toBe(true);
    expect(Exit.isSuccess(await run.retry())).toBe(true);
    run.answerWith("refuse");
    expect(Exit.isSuccess(await run.deliver())).toBe(true);
    expect((await run.issued()).rows.map(({ enabled }) => enabled)).toEqual([
      true,
      true,
    ]);
  });

  test("a disabled code prevents replay of an unresolved batch", async () => {
    const run = await setup("disabled");
    run.answerWith("interrupt");
    expect(Exit.isFailure(await run.deliver())).toBe(true);
    await pool.query(
      "update discount_codes set enabled = false where id in (select code_id from discount_code_customers where dotypos_customer_id = $1)",
      [run.recipients[0]!.dotyposCustomerId]
    );
    run.answerWith("accept");
    expect(Exit.isSuccess(await run.deliver())).toBe(true);
    expect(run.requests.length).toBe(1);
    const pending = await pool.query(
      "select 1 from email_campaign_recipients where send_id = $1 and status = 'unconfirmed'",
      [run.sendId]
    );
    expect(pending.rowCount).toBe(2);
  });
});
