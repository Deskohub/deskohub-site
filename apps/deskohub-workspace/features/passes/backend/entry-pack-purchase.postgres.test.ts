import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DotyposCustomerIdSchema } from "@deskohub/dotypos";
import {
  EmailConfigTag,
  EmailDeliveryIdSchema,
  type EmailMessage,
  EmailServiceError,
  EmailServiceTag,
} from "@deskohub/email";
import { NexiOperationIdSchema, NexiService } from "@deskohub/nexi";
import { testEmailAddress } from "@deskohub/test-email";
import { Effect, Layer } from "effect";
import { promotionCodes, vouchers } from "@/db/schema";
import { CurrentCustomerAccount } from "@/features/account/backend/current-customer-account";
import { CustomerAccountContactService } from "@/features/account/backend/customer-account-contact.service";
import {
  CustomerAccountSections,
  HeldCustomerAccount,
} from "@/features/account/backend/customer-account-sections";
import { testSessionProfile } from "@/features/account/backend/customer-authentication.test-utils";
import { CheckoutAnalytics } from "@/features/checkout/backend/analytics/checkout-analytics.service";
import { NexiWebhookService } from "@/features/checkout/backend/payment/nexi-webhook.service";
import { OrderPaymentHandlers } from "@/features/checkout/backend/payment/order-payment-handlers.service";
import { PaymentRefundService } from "@/features/checkout/backend/payment/payment-refund.service";
import { LegalEvidenceEventRepository } from "@/features/checkout/backend/repositories/legal-evidence-event.repository";
import { PaymentAttemptRepository } from "@/features/checkout/backend/repositories/payment-attempt.repository";
import { WebhookEventRepository } from "@/features/checkout/backend/repositories/webhook-event.repository";
import { calculateDiscounts } from "@/features/discounts/calculator";
import { makeDiscountCommitment } from "@/features/discounts/commitment";
import { canonicalPromotionCodeSchema } from "@/features/discounts/contracts";
import { DiscountService } from "@/features/discounts/discount.service";
import { deriveOpaqueDiscountId } from "@/features/discounts/opaque-discount-id";
import type { DiscountCandidate } from "@/features/discounts/provider";
import { WorkspaceFeatureFlagService } from "@/features/feature-flags/backend/workspace-feature-flag.service";
import { m } from "@/features/i18n";
import { orderIdSchema } from "@/features/order";
import { findOrderKind } from "@/features/order/backend/order-kind";
import { currencyCZK } from "@/shared/money/currencies";
import { fixtureReservationAuthorId as accountId } from "@/shared/testing/workspace-fixtures.test-utils";
import {
  createWorkspacePostgresSuiteDatabase,
  type WorkspacePostgresSuiteDatabase,
} from "@/shared/testing/workspace-postgres-test-database.test-utils";
import { atInstant } from "@/shared/testing/workspace-test-clock.test-utils";
import { makeEntryPackOrderPaymentHandler } from "./entry-pack-order-payment-handler";
import {
  beginEntryPackPurchase,
  getEntryPackPaymentDisclosure,
  payForEntryPack,
  recordEntryPackPaymentConsent,
} from "./entry-pack-purchase";
import { settleEntryPack } from "./entry-pack-settlement";

describe.skipIf(!process.env.WORKSPACE_TEST_DATABASE_URL)(
  "Entry pack purchase",
  () => {
    let database: WorkspacePostgresSuiteDatabase | null;
    beforeAll(async () => {
      database = await createWorkspacePostgresSuiteDatabase(
        "entry_pack_purchase"
      );
      await database?.pool.query(
        'insert into auth."user" (id, name, email, email_verified) values ($1, $2, $3, true)',
        [accountId, "", email]
      );
    });
    afterAll(async () => {
      await database?.close();
    });

    const email = testEmailAddress("pass-buyer");
    const dotyposCustomerId = DotyposCustomerIdSchema.make("pass-buyer");
    const session = {
      accountId,
      email,
      deletionRequested: false,
      ...testSessionProfile,
    };
    const purchaseServices = Layer.mergeAll(
      Layer.mock(CurrentCustomerAccount, {
        requireActive: Effect.succeed(session),
        peek: Effect.succeed({
          kind: "linked",
          account: { accountId, dotyposCustomerId },
          session,
          autoLinked: false,
          reviewMarker: "absent",
        } as const),
      }),
      Layer.mock(CustomerAccountSections, {
        withActiveAccount: (_buyerId, operation) =>
          Effect.provideService(operation, HeldCustomerAccount, {
            accountId,
            email,
          }),
      }),
      Layer.mock(CustomerAccountContactService, {
        linkedContact: () =>
          Effect.succeed({
            accountId,
            dotyposCustomerId,
            email,
            name: "Fixture Buyer",
            phone: null,
          }),
      }),
      Layer.mock(WorkspaceFeatureFlagService, {
        isEnabled: () => Effect.succeed(true),
      }),
      Layer.mock(DiscountService, {
        quote: (input) =>
          calculateDiscounts({ ...input, candidates: [] }).pipe(
            Effect.map(({ quote }) => quote)
          ),
      })
    );

    const integration = async (
      db: WorkspacePostgresSuiteDatabase,
      voucherValue: number,
      purchasedAt?: Temporal.Instant
    ) => {
      const code = canonicalPromotionCodeSchema.make(
        `V${crypto.randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase()}`
      );
      const [promotion] = await Effect.runPromise(
        db.db
          .insert(promotionCodes)
          .values({ kind: "voucher", code, enabled: true })
          .returning()
      );
      const [voucher] = await Effect.runPromise(
        db.db
          .insert(vouchers)
          .values({
            promotionCodeId: promotion!.id,
            issuedAmountValue: voucherValue,
            issuedAmountExponent: 2,
            issuedAmountCurrency: "CZK",
          })
          .returning()
      );
      const amount = currencyCZK(voucherValue);
      const candidate: DiscountCandidate = {
        discount: {
          id: deriveOpaqueDiscountId({
            providerNamespace: "database-voucher",
            providerReference: voucher!.id,
          }),
          label: m.checkoutVoucherLabel({}, { locale: "en-US" }),
          adjustment: { kind: "fixed", amount },
        },
        provenance: {
          providerNamespace: "database-voucher",
          providerReference: voucher!.id,
          details: { voucherId: voucher!.id },
        },
        claim: {
          kind: "voucher",
          voucherId: voucher!.id,
          availableAmount: amount,
          dotyposCustomerId,
        },
      };
      const mail: EmailMessage[] = [];
      const attemptedKeys: (string | undefined)[] = [];
      let failSend = false;
      const { layer } = await Effect.runPromise(
        Effect.gen(function* () {
          const handler = yield* makeEntryPackOrderPaymentHandler;
          return {
            layer: Layer.succeed(
              OrderPaymentHandlers,
              OrderPaymentHandlers.make(
                { "pass-purchase": handler },
                (orderId) =>
                  findOrderKind(orderId).pipe(Effect.provide(db.layer))
              )
            ),
          };
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              db.layer,
              Layer.succeed(EmailConfigTag, {
                defaultFrom: { email: testEmailAddress("pass-sender") },
              }),
              Layer.mock(EmailServiceTag, {
                send: (message) =>
                  Effect.suspend(() => {
                    attemptedKeys.push(message.idempotencyKey);
                    if (failSend) {
                      failSend = false;
                      return Effect.fail(
                        new EmailServiceError("Synthetic email failure.")
                      );
                    }
                    mail.push(message);
                    return Effect.succeed({
                      id: EmailDeliveryIdSchema.make(
                        "synthetic-pass-confirmation"
                      ),
                      status: "sent" as const,
                      provider: "fixture",
                      timestamp: new Date(),
                    });
                  }),
              })
            )
          )
        )
      );
      const providerOrders: string[] = [];
      let captured = true;
      const services = Layer.mergeAll(
        db.layer,
        purchaseServices,
        layer,
        LegalEvidenceEventRepository.Default.pipe(Layer.provide(db.layer)),
        PaymentAttemptRepository.Default.pipe(Layer.provide(db.layer)),
        WebhookEventRepository.Default.pipe(Layer.provide(db.layer)),
        Layer.mock(PaymentRefundService, {}),
        Layer.mock(CheckoutAnalytics, {
          paymentStarted: () => Effect.void,
          paymentCompleted: () => Effect.void,
          paymentFailed: () => Effect.void,
        }),
        Layer.mock(DiscountService, {
          quote: (input) =>
            calculateDiscounts({ ...input, candidates: [candidate] }).pipe(
              Effect.map(({ quote }) => quote)
            ),
          affirmDisplayedDiscounts: (input) =>
            calculateDiscounts({ ...input, candidates: [candidate] }).pipe(
              Effect.map(({ quote, applications }) => ({
                quote,
                commitment: makeDiscountCommitment({
                  product: input.product,
                  firstServiceDate: input.firstServiceDate,
                  applications,
                }),
              }))
            ),
        }),
        Layer.mock(NexiService, {
          createHostedPaymentPage: ({ orderId }) =>
            Effect.sync(() => {
              providerOrders.push(orderId);
              return {
                orderId,
                hostedPage: "https://nexi.test/payment",
                securityToken: "synthetic-session",
              };
            }),
          verifyPaymentOutcome: (input) =>
            Effect.succeed({
              status: captured ? "success" : "failure",
              provider: {
                orderId: input.orderId,
                operationId: NexiOperationIdSchema.make("synthetic-operation"),
                operationCount: 1,
                amount: input.amount,
                authorizedAmount: undefined,
                capturedAmount: captured ? input.amount : undefined,
                currency: input.currency,
                orderStatus: captured ? "EXECUTED" : "DECLINED",
                captureExecuted: captured,
              },
              mismatches: [],
            }),
        })
      );
      const orderId = orderIdSchema.make(crypto.randomUUID());
      const begin = beginEntryPackPurchase({
        orderId,
        product: { kind: "entry-pack", tier: "open-space", size: 5 },
        locale: "en-US",
        submittedCode: code,
      }).pipe(Effect.provide(services));
      await Effect.runPromise(
        purchasedAt ? begin.pipe(atInstant(purchasedAt)) : begin
      );
      const accept = {
        orderId,
        accepted: true,
        acceptedDocuments: getEntryPackPaymentDisclosure("en-US").documents,
        submittedCode: code,
      };
      const notify = async (payment: "failure" | "success") => {
        captured = payment === "success";
        await Effect.runPromise(
          Effect.flatMap(NexiWebhookService, (webhook) =>
            webhook.processNotification({
              eventId: crypto.randomUUID(),
              securityToken: "synthetic-session",
              operation: {
                orderId: providerOrders[0],
                operationId: crypto.randomUUID(),
                operationType: "CAPTURE",
                operationResult: captured ? "EXECUTED" : "DECLINED",
                operationAmount: String(115_000 - voucherValue),
                operationCurrency: "CZK",
              },
            })
          ).pipe(
            Effect.provide(
              NexiWebhookService.Default.pipe(Layer.provide(services))
            )
          )
        );
      };
      return {
        orderId,
        mail,
        attemptedKeys,
        rejectNextEmail: () => {
          failSend = true;
        },
        providerOrders,
        notify,
        pay: (at?: Temporal.Instant) => {
          const pay = payForEntryPack(accept).pipe(Effect.provide(services));
          return Effect.runPromise(at ? pay.pipe(atInstant(at)) : pay);
        },
      };
    };

    test.each([2_000, 115_000])(
      "requires a fresh quote on the exclusive Prague end date for voucher value %i",
      async (voucherValue) => {
        const db = database!;
        const payment = await integration(
          db,
          voucherValue,
          Temporal.Instant.from("2026-11-19T12:00:00Z")
        );

        await expect(
          payment.pay(Temporal.Instant.from("2027-01-18T23:00:00Z"))
        ).rejects.toMatchObject({
          _tag: "EntryPackPurchaseError",
          reason: "quote-expired",
        });
        expect(payment.providerOrders).toEqual([]);
        const attempts = await db.pool.query(
          "select id from payment_attempts where order_id = $1",
          [payment.orderId]
        );
        expect(attempts.rows).toEqual([]);
      }
    );

    test("admits buyer voucher, releases it on terminal failure and redeems it on verified late capture", async () => {
      const db = database!;
      const payment = await integration(db, 2_000);
      expect(await payment.pay()).toMatchObject({ status: "hosted" });
      expect(await payment.pay()).toMatchObject({ status: "hosted" });
      expect(payment.providerOrders).toHaveLength(1);
      const claims = () =>
        db.pool.query(
          `select vr.state, vr.dotypos_customer_id, pa.workspace_reservation_id
         from voucher_redemptions vr join payment_attempts pa on pa.id = vr.payment_attempt_id
         where pa.order_id = $1`,
          [payment.orderId]
        );
      expect((await claims()).rows).toEqual([
        {
          state: "reserved",
          dotypos_customer_id: dotyposCustomerId,
          workspace_reservation_id: null,
        },
      ]);
      await payment.notify("failure");
      expect((await claims()).rows[0]?.state).toBe("released");
      expect(
        (
          await db.pool.query(
            "select status from pass_purchases where id = $1",
            [payment.orderId]
          )
        ).rows
      ).toEqual([{ status: "void" }]);
      await payment.notify("success");
      await payment.notify("success");
      expect((await claims()).rows[0]?.state).toBe("redeemed");
      expect(
        (
          await db.pool.query(
            "select status from pass_purchases where id = $1",
            [payment.orderId]
          )
        ).rows
      ).toEqual([{ status: "active" }]);
      expect(payment.mail).toHaveLength(1);
      expect(payment.mail[0]).toMatchObject({
        to: { email },
        idempotencyKey: `entry-pack-purchase:${payment.orderId}`,
      });
    });

    test("keeps payment settled and retries confirmation with the same key after a send failure", async () => {
      const db = database!;
      const payment = await integration(db, 2_000);
      await payment.pay();
      payment.rejectNextEmail();
      await expect(payment.notify("success")).rejects.toBeDefined();
      expect(
        (
          await db.pool.query(
            "select payment_state, fulfillment_state from orders where id = $1",
            [payment.orderId]
          )
        ).rows
      ).toEqual([{ payment_state: "paid", fulfillment_state: "not_started" }]);
      await payment.notify("success");
      await payment.notify("success");
      expect(payment.attemptedKeys).toEqual([
        `entry-pack-purchase:${payment.orderId}`,
        `entry-pack-purchase:${payment.orderId}`,
      ]);
      expect(payment.mail).toHaveLength(1);
    });

    test("records a superseded capture for refund without replacing the current attempt", async () => {
      const db = database!;
      const payment = await integration(db, 2_000);
      await payment.pay();
      await payment.notify("failure");
      await payment.pay();
      expect(payment.providerOrders).toHaveLength(2);
      await payment.notify("success");
      expect(
        (
          await db.pool.query(
            "select status from pass_purchases where id = $1",
            [payment.orderId]
          )
        ).rows
      ).toEqual([{ status: "pending_payment" }]);
      const attempts = await db.pool.query(
        "select state, refund_state from payment_attempts where order_id = $1 order by created_at, id",
        [payment.orderId]
      );
      expect(attempts.rows).toEqual([
        { state: "paid", refund_state: "required" },
        { state: "pending", refund_state: "not_required" },
      ]);
      expect(payment.mail).toHaveLength(0);
    });

    test("uses an internal paid attempt for a fully covered pack", async () => {
      const db = database!;
      const payment = await integration(db, 115_000);
      expect(await payment.pay()).toMatchObject({ status: "paid" });
      expect(await payment.pay()).toMatchObject({ status: "paid" });
      expect(payment.providerOrders).toEqual([]);
      expect(payment.mail).toHaveLength(1);
      expect(
        (
          await db.pool.query(
            `select pa.provider, pa.amount_value, vr.state from payment_attempts pa
         join voucher_redemptions vr on vr.payment_attempt_id = pa.id where pa.order_id = $1`,
            [payment.orderId]
          )
        ).rows
      ).toEqual([{ provider: "internal", amount_value: 0, state: "redeemed" }]);
    });

    test("creates one pending order with an empty ledger and stores the accepted consent", async () => {
      const db = database!;
      const orderId = orderIdSchema.make(crypto.randomUUID());
      const holderEmail = testEmailAddress("pass-holder");
      const begin = beginEntryPackPurchase({
        orderId,
        product: { kind: "entry-pack", size: 10, tier: "reserved-desk" },
        holderEmail,
        locale: "en-US",
      }).pipe(Effect.provide(Layer.merge(db.layer, purchaseServices)));

      const first = await Effect.runPromise(begin);
      const retry = await Effect.runPromise(begin);
      expect(retry).toEqual(first);
      expect(first).toMatchObject({
        id: orderId,
        buyerAccountId: accountId,
        status: "pending_payment",
        entryCount: 10,
      });
      expect(first.holderAccountId).not.toBe(accountId);
      const holder = await db.pool.query(
        'select login.email, login.email_verified, account.dotypos_customer_id from auth."user" login join customer_accounts account using (id) where login.id = $1',
        [first.holderAccountId]
      );
      expect(holder.rows).toEqual([
        {
          email: holderEmail,
          email_verified: false,
          dotypos_customer_id: null,
        },
      ]);
      const { rows } = await db.pool.query(
        "select kind, payment_state from orders where id = $1",
        [orderId]
      );
      expect(rows).toEqual([
        { kind: "pass-purchase", payment_state: "not_started" },
      ]);
      expect(
        (
          await db.pool.query(
            "select 1 from pass_entry_claims where pass_id = $1",
            [orderId]
          )
        ).rowCount
      ).toBe(0);

      const consent = (
        accepted: boolean,
        acceptedDocuments = getEntryPackPaymentDisclosure(
          first.locale
        ).documents
      ) =>
        recordEntryPackPaymentConsent({
          orderId,
          accepted,
          acceptedDocuments,
        }).pipe(
          Effect.provide(
            Layer.merge(
              purchaseServices,
              LegalEvidenceEventRepository.Default.pipe(
                Layer.provideMerge(db.layer)
              )
            )
          )
        );

      await expect(Effect.runPromise(consent(false))).rejects.toMatchObject({
        reason: "consent-required",
      });
      await expect(Effect.runPromise(consent(true, []))).rejects.toMatchObject({
        reason: "terms-changed",
      });
      await Effect.runPromise(consent(true));
      const evidence = await db.pool.query(
        "select document_key, workspace_reservation_id, acknowledgements from legal_evidence_events where order_id = $1 order by document_key",
        [orderId]
      );
      expect(evidence.rows).toEqual([
        {
          document_key: "operatingRules",
          workspace_reservation_id: null,
          acknowledgements: {},
        },
        {
          document_key: "termsAndConditions",
          workspace_reservation_id: null,
          acknowledgements: {
            earlyPerformanceConsent: true,
            entryPackEarlyStartRequested: true,
          },
        },
      ]);
    });

    test("reuses one unverified holder across concurrent purchases with the same login email", async () => {
      const db = database!;
      const holderEmail = testEmailAddress("shared-pack-holder");
      const begin = (email: string) =>
        Effect.runPromise(
          beginEntryPackPurchase({
            orderId: orderIdSchema.make(crypto.randomUUID()),
            product: { kind: "entry-pack", size: 5, tier: "open-space" },
            locale: "en-US",
            holderEmail: email,
          }).pipe(Effect.provide(Layer.merge(db.layer, purchaseServices)))
        );
      const [first, second] = await Promise.all([
        begin(holderEmail),
        begin(holderEmail.toUpperCase()),
      ]);
      expect(second.holderAccountId).toBe(first.holderAccountId);
      const holder = await db.pool.query(
        'select email_verified from auth."user" where email = $1',
        [holderEmail]
      );
      expect(holder.rows).toEqual([{ email_verified: false }]);
    });

    test("voids unpaid packs and activates verified late payments just once", async () => {
      const db = database!;
      const orderId = orderIdSchema.make(crypto.randomUUID());
      const purchase = await Effect.runPromise(
        beginEntryPackPurchase({
          orderId,
          product: { kind: "entry-pack", size: 5, tier: "open-space" },
          locale: "en-US",
        }).pipe(Effect.provide(Layer.merge(db.layer, purchaseServices)))
      );
      expect(purchase.holderAccountId).toBe(accountId);
      const settle = settleEntryPack(orderId).pipe(Effect.provide(db.layer));

      await db.pool.query(
        "update orders set payment_state = 'expired' where id = $1",
        [orderId]
      );
      await Effect.runPromise(settle);
      expect(
        (
          await db.pool.query(
            "select status from pass_purchases where id = $1",
            [orderId]
          )
        ).rows
      ).toEqual([{ status: "void" }]);

      await db.pool.query(
        "update orders set payment_state = 'paid', paid_at = now() where id = $1",
        [orderId]
      );
      expect(await Effect.runPromise(settle)).toMatchObject({
        id: orderId,
        status: "active",
      });
      expect(await Effect.runPromise(settle)).toBeUndefined();

      await db.pool.query(
        "update pass_purchases set status = 'withdrawn' where id = $1",
        [orderId]
      );
      expect(await Effect.runPromise(settle)).toBeUndefined();
      expect(
        (
          await db.pool.query(
            "select status from pass_purchases where id = $1",
            [orderId]
          )
        ).rows
      ).toEqual([{ status: "withdrawn" }]);
    });
  }
);
