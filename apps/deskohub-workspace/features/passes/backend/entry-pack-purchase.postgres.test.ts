import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DotyposCustomerIdSchema } from "@deskohub/dotypos";
import {
  EmailConfigTag,
  EmailDeliveryIdSchema,
  type EmailMessage,
  EmailServiceError,
  EmailServiceTag,
} from "@deskohub/email";
import {
  ExternalAPIError,
  NetworkError,
  NexiOperationIdSchema,
  NexiService,
} from "@deskohub/nexi";
import { testEmailAddress } from "@deskohub/test-email";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { WorkspaceDatabaseAdvisoryLock } from "@/db/postgres-advisory-lock";
import { promotionCodes, vouchers } from "@/db/schema";
import { CurrentCustomerAccount } from "@/features/account/backend/current-customer-account";
import { CustomerAccountContactService } from "@/features/account/backend/customer-account-contact.service";
import {
  CustomerAccountSections,
  HeldCustomerAccount,
} from "@/features/account/backend/customer-account-sections";
import { testSessionProfile } from "@/features/account/backend/customer-authentication.test-utils";
import { accountingSnapshotKeyIdSchema } from "@/features/accounting/accounting-document-snapshot";
import { AccountingDocumentSnapshots } from "@/features/accounting/backend/accounting-document-snapshots";
import { AccountingSnapshotKeyService } from "@/features/accounting/backend/accounting-snapshot-key.service";
import { testAccountingStorage } from "@/features/accounting/backend/accounting-storage.test-utils";
import { InvoiceRepository } from "@/features/accounting/backend/invoice.repository";
import { InvoiceCancellationNotices } from "@/features/accounting/backend/invoice-cancellation-notices";
import { InvoiceEmailDeliveryRepository } from "@/features/accounting/backend/invoice-email-delivery.repository";
import { InvoiceEmailDeliveryService } from "@/features/accounting/backend/invoice-email-delivery.service";
import { companyRegistrationIdSchema } from "@/features/accounting/billing-identity";
import { getInvoicePresentation } from "@/features/accounting/invoice-presentation";
import { CheckoutAnalytics } from "@/features/checkout/backend/analytics/checkout-analytics.service";
import { PaymentPageProviderStatus } from "@/features/checkout/backend/checkout/payment-page-provider-status";
import { NexiWebhookService } from "@/features/checkout/backend/payment/nexi-webhook.service";
import { OrderPaymentHandlers } from "@/features/checkout/backend/payment/order-payment-handlers.service";
import { PaymentProvidersFromNexi } from "@/features/checkout/backend/payment/payment-providers";
import { PaymentRefundService } from "@/features/checkout/backend/payment/payment-refund.service";
import { ProviderPaymentFinalizationService } from "@/features/checkout/backend/payment/provider-payment-finalization.service";
import { LegalEvidenceEventRepository } from "@/features/checkout/backend/repositories/legal-evidence-event.repository";
import { PaymentAttemptRepository } from "@/features/checkout/backend/repositories/payment-attempt.repository";
import { WebhookEventRepository } from "@/features/checkout/backend/repositories/webhook-event.repository";
import { paymentAttemptIdSchema } from "@/features/checkout/checkout-identifiers";
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
import type { ReservationBillingSelection } from "@/features/reservation/reservation-billing";
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
import { reconcilePassPurchases } from "./pass-purchase-reconciliation";

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
      purchasedAt?: Temporal.Instant,
      billing?: ReservationBillingSelection
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
      let failInternalInvoice = false;
      let beforeAdmission = Effect.void;
      const rejectedConfirmations = new Set<string>();
      const inconclusiveProviderOrders = new Set<string>();
      let buyerName = "Fixture Buyer";
      const invoiceDeliveries = new Set<string>();
      const key = {
        id: accountingSnapshotKeyIdSchema.make("PASS_TEST"),
        secret: "synthetic pass accounting key for PostgreSQL",
      };
      const accounting = testAccountingStorage(
        db.layer,
        Layer.succeed(AccountingSnapshotKeyService, {
          getActive: Effect.succeed(key),
          getById: () => Effect.succeed(key),
        })
      );
      const deliveryAttempts: string[] = [];
      const emailLayer = Layer.merge(
        Layer.succeed(EmailConfigTag, {
          defaultFrom: { email: testEmailAddress("pass-sender") },
        }),
        Layer.mock(EmailServiceTag, {
          send: (message) =>
            Effect.suspend(() => {
              const key = message.idempotencyKey ?? "";
              if (key.startsWith("entry-pack-purchase:")) {
                attemptedKeys.push(key);
                if (failSend || rejectedConfirmations.has(key)) {
                  failSend = false;
                  return Effect.fail(
                    new EmailServiceError("Synthetic confirmation failure.")
                  );
                }
                mail.push(message);
              } else {
                deliveryAttempts.push(key);
                if (
                  key.startsWith("workspace-invoice-internal-") &&
                  failInternalInvoice
                ) {
                  failInternalInvoice = false;
                  return Effect.fail(
                    new EmailServiceError("Synthetic internal invoice failure.")
                  );
                }
                if (key.startsWith("workspace-invoice-customer-")) {
                  invoiceDeliveries.add(
                    key.slice("workspace-invoice-customer-".length)
                  );
                }
              }
              return Effect.succeed({
                id: EmailDeliveryIdSchema.make(crypto.randomUUID()),
                status: "sent" as const,
                provider: "fixture",
                timestamp: new Date(),
              });
            }),
        })
      );
      const invoiceDeliveryLedger = InvoiceEmailDeliveryRepository.Default.pipe(
        Layer.provide(db.layer)
      );
      const invoiceDelivery = InvoiceEmailDeliveryService.Default.pipe(
        Layer.provide(
          Layer.mergeAll(
            accounting,
            emailLayer,
            invoiceDeliveryLedger,
            Layer.mock(InvoiceCancellationNotices, {
              ensureOwed: () => Effect.void,
            })
          )
        )
      );
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
              accounting,
              invoiceDeliveryLedger,
              invoiceDelivery,
              emailLayer,
              WorkspaceDatabaseAdvisoryLock.makeLayer(db.databasePool)
            )
          )
        )
      );
      const providerOrders: string[] = [];
      let captured = true;
      let abandoned = false;
      let failCreation = false;
      const services = Layer.mergeAll(
        db.layer,
        purchaseServices,
        layer,
        accounting,
        Layer.mock(CustomerAccountContactService, {
          linkedContact: () =>
            Effect.sync(() => ({
              accountId,
              dotyposCustomerId,
              email,
              name: buyerName,
              phone: null,
            })),
        }),
        Layer.mock(PaymentPageProviderStatus, {
          observe: () => Effect.succeed("no_activity"),
        }),
        LegalEvidenceEventRepository.Default.pipe(Layer.provide(db.layer)),
        PaymentAttemptRepository.Default.pipe(Layer.provide(db.layer)),
        WebhookEventRepository.Default.pipe(Layer.provide(db.layer)),
        Layer.mock(PaymentRefundService, {}),
        Layer.mock(CheckoutAnalytics, {
          paymentStarted: () => Effect.void,
          paymentCompleted: () => Effect.void,
          paymentFailed: () => Effect.void,
          paymentAbandoned: () => Effect.void,
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
              })),
              Effect.tap(() => beforeAdmission)
            ),
        }),
        PaymentProvidersFromNexi.pipe(
          Layer.provide(
            Layer.mock(NexiService, {
              createHostedPaymentPage: ({ orderId }) =>
                Effect.suspend(() => {
                  providerOrders.push(orderId);
                  if (failCreation) {
                    failCreation = false;
                    return Effect.fail(
                      new NetworkError({
                        message: "Synthetic ambiguous Nexi creation",
                      })
                    );
                  }
                  return Effect.succeed({
                    orderId,
                    hostedPage: "https://nexi.test/payment",
                    securityToken: "synthetic-session",
                  });
                }),
              getOrder: () =>
                Effect.fail(
                  new ExternalAPIError({
                    service: "Nexi",
                    operation: "Get order",
                    statusCode: 404,
                  })
                ),
              verifyPaymentOutcome: (input) => {
                if (inconclusiveProviderOrders.has(input.orderId)) {
                  return Effect.fail(
                    new NetworkError({
                      message: "Synthetic inconclusive order",
                    })
                  );
                }
                const settledStatus = captured ? "success" : "failure";
                const settledOrderStatus = captured ? "EXECUTED" : "DECLINED";
                return Effect.succeed({
                  status: abandoned ? "pending" : settledStatus,
                  provider: {
                    orderId: input.orderId,
                    operationId: abandoned
                      ? undefined
                      : NexiOperationIdSchema.make("synthetic-operation"),
                    operationCount: abandoned ? 0 : 1,
                    amount: input.amount,
                    authorizedAmount: undefined,
                    capturedAmount:
                      captured && !abandoned ? input.amount : undefined,
                    currency: input.currency,
                    orderStatus: abandoned ? undefined : settledOrderStatus,
                    captureExecuted: captured && !abandoned,
                  },
                  mismatches: [],
                });
              },
            })
          )
        )
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
        abandoned = false;
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
        invoiceDeliveries,
        deliveryAttempts,
        rejectInternalInvoice: () => {
          failInternalInvoice = true;
        },
        rejectConfirmationFor: (id: string) => {
          rejectedConfirmations.add(`entry-pack-purchase:${id}`);
        },
        makeOrderInconclusive: (id: string) => {
          inconclusiveProviderOrders.add(id);
        },
        advanceDuringPay: () => {
          beforeAdmission = TestClock.adjust("2 seconds");
        },
        changeBuyerName: (name: string) => {
          buyerName = name;
        },
        abandonProviderOrder: () => {
          abandoned = true;
        },
        rejectNextCreation: () => {
          failCreation = true;
        },
        reconcile: (now: Temporal.Instant, limit = 25) =>
          Effect.runPromise(
            reconcilePassPurchases({ now, limit }).pipe(
              Effect.provide(ProviderPaymentFinalizationService.Default),
              Effect.provide(services),
              atInstant(now)
            )
          ),
        readAccounting: (attemptId: string, invoiceId?: string) =>
          Effect.runPromise(
            Effect.gen(function* () {
              const snapshots = yield* AccountingDocumentSnapshots;
              const invoices = yield* InvoiceRepository;
              return {
                snapshot: yield* snapshots.findEntryPack(
                  paymentAttemptIdSchema.make(attemptId)
                ),
                invoice: invoiceId ? yield* invoices.findById(invoiceId) : null,
              };
            }).pipe(Effect.provide(accounting))
          ),
        rejectNextEmail: () => {
          failSend = true;
        },
        providerOrders,
        notify,
        pay: (
          at?: Temporal.Instant,
          options?: { billing?: ReservationBillingSelection }
        ) => {
          const pay = payForEntryPack({
            ...accept,
            ...(options ?? (billing && { billing })),
          }).pipe(Effect.provide(services));
          return Effect.runPromise(at ? pay.pipe(atInstant(at)) : pay);
        },
      };
    };

    const requestedInvoice = {
      purpose: "personal",
      invoice: "requested",
      address: {
        line1: "Synthetic 8",
        city: "Praha",
        postalCode: "11000",
        country: "CZ",
      },
    } satisfies ReservationBillingSelection;

    test("reconciliation rotates past an inconclusive Nexi order at batch size one", async () => {
      const db = database!;
      const first = await integration(db, 2_000);
      const next = await integration(db, 2_000);
      const now = Temporal.Now.instant();
      await first.pay(now);
      await next.pay(now.add({ seconds: 1 }));
      next.makeOrderInconclusive(first.providerOrders[0]!);
      next.abandonProviderOrder();
      const read = (orderId: string) =>
        db.pool
          .query(
            `select a.state, v.state as claim from payment_attempts a
         join voucher_redemptions v on v.payment_attempt_id = a.id where a.order_id = $1`,
            [orderId]
          )
          .then(({ rows }) => rows);
      const afterCutoff = now.add({ minutes: 31 });
      expect(await next.reconcile(afterCutoff, 1)).toMatchObject({
        paymentsChecked: 1,
      });
      expect(await read(next.orderId)).toEqual([
        { state: "pending", claim: "reserved" },
      ]);
      expect(
        await next.reconcile(afterCutoff.add({ minutes: 10 }), 1)
      ).toMatchObject({ paymentsChecked: 1 });
      expect(await read(first.orderId)).toEqual([
        { state: "pending", claim: "reserved" },
      ]);
      expect(await read(next.orderId)).toEqual([
        { state: "expired", claim: "released" },
      ]);
      first.abandonProviderOrder();
      await first.reconcile(afterCutoff.add({ minutes: 20 }), 1);
      expect(await read(first.orderId)).toEqual([
        { state: "expired", claim: "released" },
      ]);
    });

    test("reconciliation rotates past a failing confirmation at batch size one", async () => {
      const db = database!;
      const first = await integration(db, 115_000);
      const next = await integration(db, 115_000);
      const now = Temporal.Now.instant();
      first.rejectNextEmail();
      next.rejectNextEmail();
      await first.pay(now);
      await next.pay(now.add({ seconds: 1 }));
      next.rejectConfirmationFor(first.orderId);
      const read = (orderId: string) =>
        db.pool
          .query(
            "select payment_state, fulfillment_state from orders where id = $1",
            [orderId]
          )
          .then(({ rows }) => rows);
      const firstRetry = now.add({ minutes: 10 });
      expect(await next.reconcile(firstRetry, 1)).toMatchObject({
        fulfillmentRetried: 1,
      });
      expect(await read(next.orderId)).toEqual([
        { payment_state: "paid", fulfillment_state: "not_started" },
      ]);
      expect(
        await next.reconcile(firstRetry.add({ minutes: 10 }), 1)
      ).toMatchObject({ fulfillmentRetried: 1 });
      expect(await read(first.orderId)).toEqual([
        { payment_state: "paid", fulfillment_state: "not_started" },
      ]);
      expect(await read(next.orderId)).toEqual([
        { payment_state: "paid", fulfillment_state: "fulfilled" },
      ]);
      expect(next.mail).toHaveLength(1);
      await first.reconcile(firstRetry.add({ minutes: 20 }), 1);
      expect(await read(first.orderId)).toEqual([
        { payment_state: "paid", fulfillment_state: "fulfilled" },
      ]);
    });

    test("refuses changed billing on a hosted attempt without changing the attempt or frozen choice", async () => {
      const db = database!;
      const payment = await integration(db, 2_000);
      const first = await payment.pay();
      expect(first).toMatchObject({ status: "hosted" });
      const frozen = () =>
        db.pool
          .query<{ id: string; state: string }>(
            "select id, state from payment_attempts where order_id = $1",
            [payment.orderId]
          )
          .then(({ rows }) => rows);
      const before = await frozen();
      await expect(
        payment.pay(undefined, { billing: requestedInvoice })
      ).rejects.toMatchObject({
        reason: "billing-changed",
      });
      expect(await frozen()).toEqual(before);
      expect(
        (await payment.readAccounting(before[0]!.id)).snapshot?.billing
      ).toEqual({
        purpose: "personal",
        invoice: "none",
      });
      expect(await payment.pay()).toEqual(first);
      expect(
        await payment.pay(undefined, {
          billing: { purpose: "personal", invoice: "none" },
        })
      ).toEqual(first);
      expect(payment.providerOrders).toHaveLength(1);
      await payment.notify("failure");
    });

    test("reopens a hosted payment with the same normalized invoice details and refuses different details", async () => {
      const db = database!;
      const payment = await integration(db, 2_000, undefined, requestedInvoice);
      const first = await payment.pay();
      expect(first).toMatchObject({ status: "hosted" });
      expect(await payment.pay(undefined, {})).toEqual(first);
      expect(
        await payment.pay(undefined, {
          billing: {
            ...requestedInvoice,
            address: { ...requestedInvoice.address, line1: " Synthetic 8 " },
          },
        })
      ).toEqual(first);
      await expect(
        payment.pay(undefined, {
          billing: {
            ...requestedInvoice,
            address: { ...requestedInvoice.address, line1: "Synthetic 9" },
          },
        })
      ).rejects.toMatchObject({ reason: "billing-changed" });
      expect(payment.providerOrders).toHaveLength(1);
      await payment.notify("failure");
    });

    test("retries only the failed internal invoice copy after confirming the purchase", async () => {
      const db = database!;
      const payment = await integration(
        db,
        115_000,
        undefined,
        requestedInvoice
      );
      payment.rejectInternalInvoice();
      expect(await payment.pay()).toMatchObject({ status: "paid" });
      const read = () =>
        db.pool
          .query(
            `select o.fulfillment_state, a.id as attempt_id, i.id as invoice_id,
                d.audience, d.state, d.attempt_count
         from orders o join payment_attempts a on a.order_id = o.id
         join invoices i on i.payment_attempt_id = a.id
         join invoice_email_deliveries d on d.invoice_id = i.id
         where o.id = $1 order by d.audience`,
            [payment.orderId]
          )
          .then(({ rows }) => rows);
      const failed = await read();
      expect(failed).toMatchObject([
        {
          fulfillment_state: "awaiting_delivery",
          audience: "customer",
          state: "accepted",
          attempt_count: 1,
        },
        {
          fulfillment_state: "awaiting_delivery",
          audience: "internal",
          state: "failed",
          attempt_count: 1,
        },
      ]);
      expect(payment.mail).toHaveLength(1);
      const later = Temporal.Now.instant().add({ minutes: 10 });
      await payment.reconcile(later);
      await payment.reconcile(later);
      expect(await read()).toEqual([
        { ...failed[0], fulfillment_state: "fulfilled" },
        {
          ...failed[1],
          fulfillment_state: "fulfilled",
          state: "accepted",
          attempt_count: 2,
        },
      ]);
      expect(payment.attemptedKeys).toEqual([
        `entry-pack-purchase:${payment.orderId}`,
      ]);
      expect(payment.deliveryAttempts).toHaveLength(3);
      expect(payment.providerOrders).toEqual([]);
    });

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

    test.each([2_000, 115_000])(
      "refuses locked admission when Prague midnight crosses after Pay for voucher value %i",
      async (voucherValue) => {
        const db = database!;
        const payment = await integration(
          db,
          voucherValue,
          Temporal.Instant.from("2026-11-19T12:00:00Z")
        );
        payment.advanceDuringPay();
        await expect(
          payment.pay(Temporal.Instant.from("2027-01-18T22:59:59Z"))
        ).rejects.toMatchObject({
          _tag: "PaymentLifecycleStateError",
          message: "The Entry pack quote expired. Request a new quote.",
        });
        const attempts = await db.pool.query(
          "select id from payment_attempts where order_id = $1",
          [payment.orderId]
        );
        expect(attempts.rows).toEqual([]);
        expect(payment.providerOrders).toEqual([]);
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

    test.each([2_000, 115_000])(
      "retries confirmation through reconciliation with frozen buyer accounting for voucher value %i",
      async (voucherValue) => {
        const db = database!;
        const internal = voucherValue === 115_000;
        const address = {
          line1: "Synthetic 8",
          city: "Praha",
          postalCode: "11000",
          country: "CZ",
        };
        const billing: ReservationBillingSelection = internal
          ? {
              purpose: "business",
              invoice: "required",
              buyer: {
                kind: "business",
                legalName: "Fixture Buyer Company",
                companyId: companyRegistrationIdSchema.make("12345678"),
                address,
              },
            }
          : { purpose: "personal", invoice: "requested", address };
        const frozenBuyer =
          billing.purpose === "business"
            ? billing.buyer
            : { kind: "person", legalName: "Fixture Buyer", address };
        const payment = await integration(db, voucherValue, undefined, billing);
        payment.rejectNextEmail();
        expect(await payment.pay()).toMatchObject({
          status: internal ? "paid" : "hosted",
        });
        payment.changeBuyerName("Changed Buyer Profile");
        if (!internal)
          await expect(payment.notify("success")).rejects.toBeDefined();
        const progress = () =>
          db.pool.query(
            "select payment_state, fulfillment_state from orders where id = $1",
            [payment.orderId]
          );
        expect((await progress()).rows).toEqual([
          { payment_state: "paid", fulfillment_state: "not_started" },
        ]);
        const later = Temporal.Now.instant().add({ minutes: 10 });
        await payment.reconcile(later);
        await payment.reconcile(later);
        expect((await progress()).rows).toEqual([
          { payment_state: "paid", fulfillment_state: "fulfilled" },
        ]);
        expect(payment.attemptedKeys).toEqual([
          `entry-pack-purchase:${payment.orderId}`,
          `entry-pack-purchase:${payment.orderId}`,
        ]);
        expect(payment.mail).toHaveLength(1);
        expect(payment.providerOrders).toHaveLength(internal ? 0 : 1);
        const accountingRows = await db.pool.query<{
          attempt_id: string;
          invoice_id: string;
        }>(
          `select pa.id as attempt_id, i.id as invoice_id
           from payment_attempts pa
           left join invoices i on i.payment_attempt_id = pa.id
           where pa.order_id = $1`,
          [payment.orderId]
        );
        expect(accountingRows.rows).toHaveLength(1);
        const row = accountingRows.rows[0]!;
        expect(payment.invoiceDeliveries).toEqual(new Set([row.invoice_id]));
        const { snapshot, invoice } = await payment.readAccounting(
          row.attempt_id,
          row.invoice_id
        );
        expect(snapshot).toMatchObject({
          orderId: payment.orderId,
          dotyposCustomerId,
          buyer: frozenBuyer,
          billing,
          delivery: { email },
          quote: { discountedSubtotal: { value: 115_000 - voucherValue } },
        });
        expect(invoice).toMatchObject({
          workspaceReservationId: null,
          paymentAttemptId: row.attempt_id,
          document: {
            documentKind: "pass-purchase",
            orderId: payment.orderId,
            buyer: frozenBuyer,
            delivery: { email },
          },
        });
        expect(
          invoice && getInvoicePresentation(invoice.document).lines
        ).toHaveLength(2);
      }
    );

    test.each([false, true])(
      "reconciles abandoned Nexi holds and releases claims (attached page %p)",
      async (attached) => {
        const db = database!;
        const payment = await integration(db, 2_000);
        if (attached) {
          expect(await payment.pay()).toMatchObject({ status: "hosted" });
          payment.abandonProviderOrder();
        } else {
          payment.rejectNextCreation();
          await expect(payment.pay()).rejects.toBeDefined();
        }
        const later = Temporal.Now.instant().add({ minutes: 31 });
        const read = () =>
          db.pool.query(
            `select p.status, pa.state, vr.state as claim
           from pass_purchases p join payment_attempts pa on pa.order_id = p.id
           join voucher_redemptions vr on vr.payment_attempt_id = pa.id
           where p.id = $1 order by pa.created_at, pa.id`,
            [payment.orderId]
          );
        if (attached)
          expect(await payment.pay(later)).toMatchObject({ status: "pending" });
        expect((await read()).rows).toEqual([
          {
            status: "pending_payment",
            state: attached ? "pending" : "created",
            claim: "reserved",
          },
        ]);
        await payment.reconcile(later);
        expect((await read()).rows).toEqual([
          {
            status: "void",
            state: attached ? "expired" : "failed",
            claim: "released",
          },
        ]);
        expect(await payment.pay(later)).toMatchObject({ status: "hosted" });
        expect(payment.providerOrders).toHaveLength(2);
        expect((await read()).rows.map(({ claim }) => claim)).toEqual([
          "released",
          "reserved",
        ]);
      }
    );

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
