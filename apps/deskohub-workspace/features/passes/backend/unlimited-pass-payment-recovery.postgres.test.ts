import "@/shared/testing/workspace-test-env";

import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import {
  DotyposCustomerIdSchema,
  DotyposRejected,
  DotyposService,
  DotyposTableIdSchema,
  DotyposTableSchema,
} from "@deskohub/dotypos";
import { makeInMemoryDotypos } from "@deskohub/dotypos/testing";
import {
  EmailConfigTag,
  EmailDeliveryIdSchema,
  EmailServiceError,
  EmailServiceTag,
} from "@deskohub/email";
import { NexiService } from "@deskohub/nexi";
import { testEmailAddress } from "@deskohub/test-email";
import { eq } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";
import { WorkspaceDatabase } from "@/db/database.service";
import { WorkspaceDatabaseAdvisoryLock } from "@/db/postgres-advisory-lock";
import {
  customerAccounts,
  entryPackGiftInvitations,
  orders,
  passPurchases,
  paymentAttempts,
  unlimitedAutoRenewalAuthorizations,
} from "@/db/schema";
import { authUser } from "@/db/schema/auth";
import { CurrentCustomerAccount } from "@/features/account/backend/current-customer-account";
import { CustomerAccountContactService } from "@/features/account/backend/customer-account-contact.service";
import { CustomerAccountLinkRepository } from "@/features/account/backend/customer-account-link.repository";
import {
  CustomerAccountSections,
  HeldCustomerAccount,
} from "@/features/account/backend/customer-account-sections";
import { CustomerAuthentication } from "@/features/account/backend/customer-authentication.service";
import {
  signedInAuthentication,
  testSessionProfile,
} from "@/features/account/backend/customer-authentication.test-utils";
import { customerAccountIdSchema } from "@/features/account/customer-account";
import { workspaceAccountingSupplier } from "@/features/accounting/accounting-document-snapshot";
import { AccountingDocumentSnapshots } from "@/features/accounting/backend/accounting-document-snapshots";
import { InvoiceRepository } from "@/features/accounting/backend/invoice.repository";
import { InvoiceEmailDeliveryRepository } from "@/features/accounting/backend/invoice-email-delivery.repository";
import { InvoiceEmailDeliveryService } from "@/features/accounting/backend/invoice-email-delivery.service";
import { AccountingRecordUnavailable } from "@/features/accounting/backend/sealed-accounting-json";
import { invoiceIdSchema } from "@/features/accounting/manual-invoice";
import { ReservationAdministrationService } from "@/features/administration/reservation-administration.service";
import { CurrentAdministrator } from "@/features/administrators/backend/current-administrator";
import { CheckoutAnalytics } from "@/features/checkout/backend/analytics/checkout-analytics.service";
import { LatePaymentVerificationService } from "@/features/checkout/backend/payment/late-payment-verification.service";
import { OrderPaymentHandlers } from "@/features/checkout/backend/payment/order-payment-handlers.service";
import { PaymentProviders } from "@/features/checkout/backend/payment/payment-provider";
import { PaymentProvidersFromNexi } from "@/features/checkout/backend/payment/payment-providers";
import { ProviderPaymentFinalizationService } from "@/features/checkout/backend/payment/provider-payment-finalization.service";
import { LegalEvidenceEventRepository } from "@/features/checkout/backend/repositories/legal-evidence-event.repository";
import { paymentAttemptIdSchema } from "@/features/checkout/checkout-identifiers";
import { makeDiscountCommitment } from "@/features/discounts/commitment";
import { DiscountService } from "@/features/discounts/discount.service";
import { WorkspaceFeatureFlagService } from "@/features/feature-flags/backend/workspace-feature-flag.service";
import { getPaymentSubmitLegalDocuments } from "@/features/legal/payment-submit-evidence";
import { orderIdSchema } from "@/features/order";
import { GoogleCalendarWorkspaceLimitationsService } from "@/features/reservation/backend/google-calendar-workspace-limitations.service";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import { getCoworkReservationInterval } from "@/features/reservation/cowork-reservation";
import { defaultReservationBillingSelection } from "@/features/reservation/reservation-billing";
import { getCurrentWorkspaceDate } from "@/features/reservation/reservation-date";
import { sealedStateKeyIdSchema } from "@/shared/backend/sealed-state-keys.service";
import { currencyCZK } from "@/shared/money/currencies";
import {
  createWorkspacePostgresSuiteDatabase,
  requireTestDatabase,
  type WorkspacePostgresSuiteDatabase,
} from "@/shared/testing/workspace-postgres-test-database.test-utils";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import { beginUnlimitedPassChange } from "../admin/begin-unlimited-pass-change";
import { completePassChange } from "../admin/complete-pass-change";
import { unlimitedPassDays } from "../pass-offer";
import { passPurchaseQuoteCodec } from "../pass-purchase-quote";
import { makeEntryPackOrderPaymentHandler } from "./entry-pack-order-payment-handler";
import {
  payForEntryPack,
  repriceEntryPackPurchase,
} from "./entry-pack-purchase";
import { getPassPurchasePriceFingerprint } from "./entry-pack-quote";
import {
  canConfirmUnlimitedPass,
  settlePassPurchase,
} from "./entry-pack-settlement";
import {
  reconcilePassPurchases,
  reconcileUnlimitedPassReleases,
} from "./pass-purchase-reconciliation";
import { readUnlimitedAutoRenewalDisclosure } from "./unlimited-auto-renewal";
import { recordUnlimitedAutoRenewalAuthorization } from "./unlimited-auto-renewal-ledger";
import {
  cancelUnlimitedAutoRenewal,
  listUnlimitedAutoRenewals,
} from "./unlimited-auto-renewal-management";
import {
  confirmUnlimitedPassDays,
  createUnlimitedPassHolds,
  readUnlimitedPassDays,
  reconfirmUnlimitedPassHolds,
} from "./unlimited-pass-holds";
import { recordUnlimitedPassOrder } from "./unlimited-pass-orders";

let database: WorkspacePostgresSuiteDatabase | null;
beforeAll(async () => {
  database = await createWorkspacePostgresSuiteDatabase(
    "unlimited_payment_recovery"
  );
});
afterAll(async () => {
  await database?.close();
});

const it = test.skipIf(!process.env.WORKSPACE_TEST_DATABASE_URL);
const renewalPreviewEnabled = mock(() => false);
mock.module("./unlimited-auto-renewal-preview.server", () => ({
  isUnlimitedAutoRenewalPreviewEnabled: renewalPreviewEnabled,
}));
const customerId = DotyposCustomerIdSchema.make("123");
const tableId = DotyposTableIdSchema.make("42");
const table = Schema.decodeUnknownSync(DotyposTableSchema)({
  id: tableId,
  _cloudId: "1",
  display: true,
  enabled: true,
  name: "Synthetic reserved desk",
  seats: "1",
  tags: ["cowork:reserved-desk"],
});
const provider = makeInMemoryDotypos({ tables: [table] });
const date = (day: Temporal.PlainDate) =>
  plainDateStringSchema.make(day.toString());
const price = currencyCZK(599_000);

const recordPurchase = (
  now: Temporal.Instant,
  startDaysAhead = 10,
  tier: "reserved-desk" | "open-space" = "reserved-desk",
  autoRenew?: true,
  previous?: Pick<
    typeof passPurchases.$inferSelect,
    "id" | "buyerAccountId" | "validUntil"
  >
) =>
  Effect.gen(function* () {
    const { db, transaction } = yield* WorkspaceDatabase;
    const accountId =
      previous?.buyerAccountId ??
      customerAccountIdSchema.make(crypto.randomUUID());
    if (!previous) yield* db.insert(customerAccounts).values({ id: accountId });
    const start = previous
      ? Temporal.PlainDate.from(previous.validUntil)
      : getCurrentWorkspaceDate(now).add({ days: startDaysAhead });
    return yield* transaction(
      recordUnlimitedPassOrder({
        orderId: orderIdSchema.make(crypto.randomUUID()),
        locale: "en-US",
        ...(autoRenew && { autoRenew }),
        ...(previous && { renewsPassId: previous.id }),
        buyer: { accountId, customerId },
        holder: { accountId, customerId },
        createdAt: now,
        selection:
          tier === "open-space"
            ? { startDate: date(start), tier, coffee: false }
            : { startDate: date(start), tier },
        quote: {
          product: { kind: "unlimited", tier },
          discountableSubtotal: price,
          discountedSubtotal: price,
          totalDiscount: currencyCZK(0),
          discounts: [],
        },
        days: Array.from({ length: unlimitedPassDays }, (_, offset) => ({
          serviceDate: date(start.add({ days: offset })),
          tableId,
        })),
      })
    );
  });

const readState = (orderId: typeof orders.$inferSelect.id) =>
  Effect.gen(function* () {
    const { db } = yield* WorkspaceDatabase;
    const [order] = yield* db
      .select()
      .from(orders)
      .where(eq(orders.id, orderId));
    const [purchase] = yield* db
      .select()
      .from(passPurchases)
      .where(eq(passPurchases.id, orderId));
    const attempts = yield* db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.orderId, orderId));
    return { order, purchase, attempts };
  });

const recordAttempt = (
  orderId: typeof orders.$inferSelect.id,
  state: "expired" | "paid",
  now: Temporal.Instant
) =>
  Effect.gen(function* () {
    const { db } = yield* WorkspaceDatabase;
    const id = paymentAttemptIdSchema.make(crypto.randomUUID());
    yield* db.insert(paymentAttempts).values({
      id,
      orderId,
      provider: "nexi",
      providerOrderId: id,
      state,
      failureCode: state === "expired" ? "fixture_expired" : null,
      amountValue: price.value,
      amountExponent: 2,
      currency: "CZK",
      updatedAt: now,
    });
    return id;
  });

const servicesFor = (dotypos: typeof DotyposService.Service) => {
  const db = requireTestDatabase(database);
  return Layer.mergeAll(
    db.layer,
    WorkspaceDatabaseAdvisoryLock.makeLayer(db.databasePool),
    Layer.succeed(DotyposService, dotypos),
    WorkspaceReservationRepository.Default.pipe(Layer.provide(db.layer)),
    Layer.mock(GoogleCalendarWorkspaceLimitationsService, {
      listLimitations: () => Effect.succeed([]),
    }),
    Layer.mock(CustomerAccountSections, {}),
    Layer.mock(EmailConfigTag, {}),
    Layer.mock(EmailServiceTag, {}),
    Layer.mock(AccountingDocumentSnapshots, {
      findPassPurchase: () => Effect.undefined,
      recordPassPurchase: () => Effect.void,
    }),
    Layer.mock(InvoiceRepository, { issueEntryPack: () => Effect.undefined }),
    Layer.mock(InvoiceEmailDeliveryService, {}),
    Layer.mock(InvoiceEmailDeliveryRepository, {}),
    Layer.mock(PaymentProviders, { activeProviders: ["nexi"] }),
    Layer.mock(ProviderPaymentFinalizationService, {})
  );
};

const withInterruptedHoldRead = (service: typeof DotyposService.Service) => {
  let interruptRead = true;
  return {
    ...service,
    getReservationsByIds: (ids, options) =>
      Effect.suspend(() => {
        if (!interruptRead) return service.getReservationsByIds(ids, options);
        interruptRead = false;
        return Effect.fail(
          new DotyposRejected({
            operation: "getReservationsByIds",
            reason: "invalid-response",
          })
        );
      }),
  } satisfies typeof DotyposService.Service;
};

for (const { boundary, daysAhead } of [
  { boundary: "a failed provider read", daysAhead: 465 },
  { boundary: "payment with a stale price", daysAhead: 505 },
  { boundary: "repricing discounts", daysAhead: 545 },
  { boundary: "payment discount affirmation", daysAhead: 585 },
] as const) {
  it(`returns quote-expired at checkout when the first day closes at ${boundary}`, async () => {
    const start = getCurrentWorkspaceDate().add({ days: daysAhead });
    const closesAt = Temporal.Instant.from(
      getCoworkReservationInterval("reserved-desk", start.toString()).endsAt
    );
    const beforeClosing = closesAt.subtract({ minutes: 2 });
    const closeFirstDay = TestClock.setTime(closesAt.epochMilliseconds);
    const services = servicesFor({
      ...provider.service,
      getReservationsByIds: (ids, options) =>
        boundary === "a failed provider read"
          ? closeFirstDay.pipe(
              Effect.andThen(
                Effect.fail(
                  new DotyposRejected({
                    operation: "getReservationsByIds",
                    reason: "invalid-response",
                  })
                )
              )
            )
          : provider.service.getReservationsByIds(ids, options),
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(beforeClosing.epochMilliseconds);
        const purchase = yield* recordPurchase(beforeClosing, 0);
        yield* createUnlimitedPassHolds(purchase);
        const handler = yield* makeEntryPackOrderPaymentHandler;
        const session = {
          accountId: purchase.buyerAccountId,
          email: testEmailAddress("cutoff-buyer"),
          deletionRequested: false,
          ...testSessionProfile,
        };
        const storedQuote = yield* Schema.decodeEffect(passPurchaseQuoteCodec)(
          purchase.quote
        );
        const quote = {
          ...storedQuote,
          discountableSubtotal: currencyCZK(100_000),
          discountedSubtotal: currencyCZK(100_000),
        };
        const stale = boundary === "payment with a stale price";
        const input = {
          orderId: purchase.id,
          productKind: "unlimited",
          displayedPriceFingerprint: getPassPurchasePriceFingerprint(
            stale ? quote : storedQuote
          ),
        } as const;
        if (stale) yield* closeFirstDay;
        const checkout =
          boundary === "repricing discounts"
            ? repriceEntryPackPurchase(input)
            : payForEntryPack({
                ...input,
                accepted: true,
                acceptedDocuments: [],
              });
        const outcome = yield* checkout.pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(CurrentCustomerAccount, {
                requireActive: Effect.succeed(session),
              }),
              Layer.mock(CustomerAccountSections, {
                withActiveAccount: (_id, work) =>
                  Effect.provideService(work, HeldCustomerAccount, session),
              }),
              Layer.mock(WorkspaceFeatureFlagService, {
                isEnabled: () => Effect.succeed(true),
              }),
              Layer.succeed(
                OrderPaymentHandlers,
                OrderPaymentHandlers.make({ "pass-purchase": handler }, () =>
                  Effect.succeed("pass-purchase")
                )
              ),
              Layer.mock(DiscountService, {
                quote: () => closeFirstDay.pipe(Effect.as(quote)),
                affirmDisplayedDiscounts: () =>
                  closeFirstDay.pipe(
                    Effect.as({
                      quote,
                      commitment: makeDiscountCommitment({
                        product: { kind: "unlimited", tier: purchase.tier },
                        firstServiceDate: purchase.validFrom,
                        applications: [],
                      }),
                    })
                  ),
              }),
              Layer.mock(CustomerAccountContactService, {}),
              Layer.mock(CheckoutAnalytics, {}),
              Layer.mock(LatePaymentVerificationService, {}),
              Layer.mock(LegalEvidenceEventRepository, {})
            )
          ),
          Effect.result
        );
        expect(outcome).toMatchObject({
          failure: { _tag: "EntryPackPurchaseError", reason: "quote-expired" },
        });
        const state = yield* readState(purchase.id);
        expect(state.purchase?.quote).toEqual(purchase.quote);
        expect(state.order?.activePaymentAttemptId).toBeNull();
        expect(state.attempts).toHaveLength(0);
      }).pipe(Effect.provide(Layer.merge(services, TestClock.layer())))
    );
  });
}

for (const { tier, closesDuring, daysAhead } of [
  { tier: "open-space", closesDuring: "provider read", daysAhead: 345 },
  { tier: "reserved-desk", closesDuring: "admission", daysAhead: 385 },
] as const) {
  it(`refuses a new ${tier} payment when the first day closes during ${closesDuring}`, async () => {
    const start = getCurrentWorkspaceDate().add({ days: daysAhead });
    const closesAt = Temporal.Instant.from(
      getCoworkReservationInterval(tier, start.toString()).endsAt
    );
    const beforeClosing = closesAt.subtract({ minutes: 2 });
    const closeFirstDay = TestClock.setTime(closesAt.epochMilliseconds);
    let providerReads = 0;
    let consentWrites = 0;
    const services = servicesFor({
      ...provider.service,
      getReservationsByIds: (ids, options) =>
        provider.service.getReservationsByIds(ids, options).pipe(
          Effect.tap(() => {
            providerReads++;
            return closesDuring === "provider read"
              ? closeFirstDay
              : Effect.void;
          })
        ),
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(beforeClosing.epochMilliseconds);
        const purchase = yield* recordPurchase(beforeClosing, 0, tier);
        yield* createUnlimitedPassHolds(purchase);
        const reconfirmed = yield* Effect.result(
          reconfirmUnlimitedPassHolds(purchase)
        );
        expect(reconfirmed._tag).toBe(
          closesDuring === "provider read" ? "Failure" : "Success"
        );

        const handler = yield* makeEntryPackOrderPaymentHandler;
        const product = { kind: "unlimited", tier } as const;
        const admitted = yield* Effect.result(
          handler.admitProvider({
            orderId: purchase.id,
            amount: price,
            locale: purchase.locale,
            provider: "nexi",
            providerOrderId: `synthetic-cutoff-${tier}`,
            details: {
              approvedAfterAttemptId: null,
              recordConsent: Effect.gen(function* () {
                consentWrites++;
                yield* closeFirstDay;
              }),
              commitment: makeDiscountCommitment({
                product,
                firstServiceDate: purchase.validFrom,
                applications: [],
              }),
              snapshot: {
                orderId: purchase.id,
                dotyposCustomerId: customerId,
                locale: purchase.locale,
                supplier: workspaceAccountingSupplier,
                buyer: { kind: "person", legalName: "Synthetic Buyer" },
                billing: defaultReservationBillingSelection,
                delivery: { email: testEmailAddress("cutoff-buyer") },
                serviceDate: purchase.validFrom,
                product,
                quote: purchase.quote,
              },
            },
          })
        );
        expect(admitted).toMatchObject({
          failure: {
            operation: "PaymentLifecycleRepository.admitUnlimitedPassFirstDay",
          },
        });
        expect(consentWrites).toBe(closesDuring === "admission" ? 1 : 0);

        const alreadyClosed = yield* Effect.result(
          reconfirmUnlimitedPassHolds(purchase)
        );
        expect(alreadyClosed).toMatchObject({
          failure: { _tag: "UnlimitedPassHoldsUnavailable", reason: "changed" },
        });
        expect(providerReads).toBe(1);

        const state = yield* readState(purchase.id);
        expect(state.order).toMatchObject({
          activePaymentAttemptId: null,
          paymentState: "not_started",
        });
        expect(state.attempts).toHaveLength(0);
      }).pipe(Effect.provide(Layer.merge(services, TestClock.layer())))
    );
  });
}

it("binds Unlimited renewal consent to the paid attempt and lets only the owner stop it", async () => {
  const now = Temporal.Now.instant();
  const databaseForRenewal = requireTestDatabase(database);
  let providerSessions = 0;
  renewalPreviewEnabled.mockReturnValue(true);
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db, transaction } = yield* WorkspaceDatabase;
        const purchase = yield* recordPurchase(now, 650, "reserved-desk", true);
        const accountId = purchase.buyerAccountId;
        const otherBuyer = customerAccountIdSchema.make(crypto.randomUUID());
        yield* db.insert(customerAccounts).values({ id: otherBuyer });
        const quote = yield* Schema.decodeEffect(passPurchaseQuoteCodec)(
          purchase.quote
        );
        const fingerprint = getPassPurchasePriceFingerprint(quote);
        const renewal = readUnlimitedAutoRenewalDisclosure(purchase);
        expect(renewal).toMatchObject({
          nextRenewalOn: purchase.validUntil,
          amount: price,
        });
        if (!renewal) throw new Error("Missing renewal agreement");
        const { termsPath, ...authorization } = renewal;
        const session = yield* Effect.flatMap(
          CustomerAuthentication,
          ({ currentUser }) => currentUser
        ).pipe(Effect.provide(signedInAuthentication(accountId)));
        if (!session) throw new Error("Missing synthetic session");
        yield* db.insert(authUser).values([
          {
            id: accountId,
            email: session.email,
            name: "Synthetic Unlimited Buyer",
            emailVerified: true,
          },
          {
            id: otherBuyer,
            email: testEmailAddress("other-unlimited-buyer"),
            name: "Synthetic Other Buyer",
            emailVerified: true,
          },
        ]);
        const handler = yield* makeEntryPackOrderPaymentHandler;
        const checkoutServices = Layer.mergeAll(
          Layer.mock(CurrentCustomerAccount, {
            requireActive: Effect.succeed(session),
          }),
          Layer.mock(WorkspaceFeatureFlagService, {
            isEnabled: () => Effect.succeed(true),
          }),
          Layer.succeed(
            OrderPaymentHandlers,
            OrderPaymentHandlers.make({ "pass-purchase": handler }, () =>
              Effect.succeed("pass-purchase")
            )
          ),
          Layer.mock(DiscountService, {
            affirmDisplayedDiscounts: () =>
              Effect.succeed({
                quote,
                commitment: makeDiscountCommitment({
                  product: { kind: "unlimited", tier: purchase.tier },
                  firstServiceDate: purchase.validFrom,
                  applications: [],
                }),
              }),
          }),
          Layer.mock(CustomerAccountContactService, {
            linkedContact: () =>
              Effect.succeed({
                accountId,
                dotyposCustomerId: customerId,
                email: session.email,
                name: "Synthetic Unlimited Buyer",
                phone: null,
              }),
          }),
          Layer.mock(CheckoutAnalytics, { paymentStarted: () => Effect.void }),
          Layer.mock(LatePaymentVerificationService, {}),
          LegalEvidenceEventRepository.Default.pipe(
            Layer.provide(databaseForRenewal.layer)
          ),
          PaymentProvidersFromNexi.pipe(
            Layer.provide(
              Layer.mock(NexiService, {
                createHostedPaymentPage: ({ orderId }) =>
                  Effect.sync(() => {
                    providerSessions += 1;
                    return {
                      orderId,
                      hostedPage: "https://nexi.test/payment",
                      securityToken: "synthetic-session",
                    };
                  }),
              })
            )
          )
        );
        const accountSectionsFor = (id: typeof accountId) =>
          CustomerAccountSections.Default.pipe(
            Layer.provide(
              Layer.mergeAll(
                CustomerAccountLinkRepository.Default.pipe(
                  Layer.provide(databaseForRenewal.layer)
                ),
                WorkspaceDatabaseAdvisoryLock.makeLayer(
                  databaseForRenewal.databasePool
                ),
                signedInAuthentication(id)
              )
            )
          );
        const pay = (
          renewalAuthorization: typeof authorization | undefined,
          displayedPriceFingerprint = fingerprint
        ) =>
          payForEntryPack({
            orderId: purchase.id,
            productKind: "unlimited",
            accepted: true,
            acceptedDocuments: getPaymentSubmitLegalDocuments(purchase.locale),
            displayedPriceFingerprint,
            ...(renewalAuthorization && { renewalAuthorization }),
          }).pipe(
            Effect.provide(
              Layer.merge(checkoutServices, accountSectionsFor(accountId))
            )
          );

        for (const invalid of [
          undefined,
          { ...authorization, amount: currencyCZK(1) },
          { ...authorization, termsHash: "0".repeat(64) },
          { ...authorization, nextRenewalOn: purchase.validFrom },
        ]) {
          expect(yield* Effect.result(pay(invalid))).toMatchObject({
            failure: { reason: "terms-changed", renewal },
          });
        }
        expect(yield* pay(authorization, "0".repeat(64))).toMatchObject({
          status: "pricing_changed",
        });
        expect((yield* readState(purchase.id)).attempts).toHaveLength(0);
        expect(providerSessions).toBe(0);

        // Keep evidence from an expired attempt so cancellation must select the paid attempt.
        const expiredAt = now.subtract({ minutes: 1 });
        const expiredId = yield* recordAttempt(
          purchase.id,
          "expired",
          expiredAt
        );
        yield* transaction(
          recordUnlimitedAutoRenewalAuthorization(
            expiredId,
            purchase.holderVersion,
            renewal,
            fingerprint,
            expiredAt
          )
        );
        yield* createUnlimitedPassHolds(purchase);
        expect(yield* pay(authorization)).toMatchObject({ status: "hosted" });
        expect(providerSessions).toBe(1);
        const { order, attempts } = yield* readState(purchase.id);
        const attempt = attempts.find(
          ({ id }) => id === order?.activePaymentAttemptId
        );
        if (!attempt) throw new Error("Missing payment attempt");
        const evidence = db
          .select()
          .from(unlimitedAutoRenewalAuthorizations)
          .where(
            eq(unlimitedAutoRenewalAuthorizations.paymentAttemptId, attempt.id)
          );
        expect((yield* evidence)[0]).toMatchObject({
          amountValue: price.value,
          nextRenewalOn: purchase.validUntil,
          termsHash: authorization.termsHash,
          termsPath,
          quoteFingerprint: fingerprint,
          cancelledAt: null,
        });
        expect((yield* listUnlimitedAutoRenewals(accountId)).size).toBe(0);

        yield* handler.markPaid({
          orderId: purchase.id,
          id: attempt.id,
          paidAt: now,
        });
        expect((yield* listUnlimitedAutoRenewals(accountId)).size).toBe(0);
        yield* confirmUnlimitedPassDays(purchase);
        expect(
          (yield* settlePassPurchase(purchase.id, attempt.id))?.status
        ).toBe("active");
        expect(
          (yield* listUnlimitedAutoRenewals(accountId)).get(purchase.id)
        ).toEqual({
          status: "pending",
          nextRenewalOn: purchase.validUntil,
          amount: price,
        });
        expect((yield* listUnlimitedAutoRenewals(otherBuyer)).size).toBe(0);
        expect(
          yield* cancelUnlimitedAutoRenewal(otherBuyer, purchase.id).pipe(
            Effect.provide(accountSectionsFor(otherBuyer))
          )
        ).toBe("unavailable");

        const stop = cancelUnlimitedAutoRenewal(accountId, purchase.id).pipe(
          Effect.provide(accountSectionsFor(accountId))
        );
        expect(yield* stop).toBe("cancelled");
        const [cancelled] = yield* evidence;
        expect(cancelled?.cancelledAt).not.toBeNull();
        expect(yield* stop).toBe("cancelled");
        expect((yield* evidence)[0]?.cancelledAt).toEqual(
          cancelled?.cancelledAt
        );
        const [expiredEvidence] = yield* db
          .select({
            cancelledAt: unlimitedAutoRenewalAuthorizations.cancelledAt,
          })
          .from(unlimitedAutoRenewalAuthorizations)
          .where(
            eq(unlimitedAutoRenewalAuthorizations.paymentAttemptId, expiredId)
          );
        expect(expiredEvidence?.cancelledAt).toBeNull();
        expect(
          (yield* listUnlimitedAutoRenewals(accountId)).get(purchase.id)?.status
        ).toBe("cancelled");
        expect((yield* readState(purchase.id)).purchase).toMatchObject({
          status: "active",
          validUntil: purchase.validUntil,
          accessEndsOn: null,
        });
        expect(
          (yield* readUnlimitedPassDays(purchase.id)).every(
            ({ reservationState }) => reservationState === "confirmed"
          )
        ).toBe(true);
      }).pipe(Effect.provide(servicesFor(provider.service)))
    );
  } finally {
    renewalPreviewEnabled.mockReturnValue(false);
  }
});

it.each([
  ["paid", "2031-01-08T12:00:00Z", false],
  ["partially refunded", "2031-05-08T12:00:00Z", true],
] as const)(
  "checks a %s renewal intent when a prepaid successor activates",
  async (_label, currentTime, refunded) => {
    const now = Temporal.Instant.from(currentTime);
    renewalPreviewEnabled.mockReturnValue(true);
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* TestClock.setTime(now.epochMilliseconds);
          const { db, transaction } = yield* WorkspaceDatabase;
          const source = yield* recordPurchase(now, 5, "reserved-desk", true);
          yield* db.insert(authUser).values({
            id: source.buyerAccountId,
            email: testEmailAddress(
              refunded
                ? "manual-renewal-refunded-buyer"
                : "manual-renewal-buyer"
            ),
            name: "Synthetic Renewal Buyer",
            emailVerified: true,
          });
          const paid = (purchase: typeof source) =>
            Effect.gen(function* () {
              const disclosure = readUnlimitedAutoRenewalDisclosure(purchase);
              if (!disclosure) throw new Error("Missing renewal disclosure");
              const attemptId = yield* recordAttempt(purchase.id, "paid", now);
              const quote = yield* Schema.decodeEffect(passPurchaseQuoteCodec)(
                purchase.quote
              );
              yield* transaction(
                recordUnlimitedAutoRenewalAuthorization(
                  attemptId,
                  purchase.holderVersion,
                  disclosure,
                  getPassPurchasePriceFingerprint(quote),
                  now
                )
              );
              yield* db
                .update(orders)
                .set({
                  paymentState: "paid",
                  activePaymentAttemptId: attemptId,
                  paidAt: now,
                })
                .where(eq(orders.id, purchase.id));
              yield* settlePassPurchase(purchase.id);
              return attemptId;
            });

          yield* createUnlimitedPassHolds(source);
          const firstAttempt = yield* paid(source);
          yield* confirmUnlimitedPassDays(source);
          expect(
            (yield* settlePassPurchase(source.id, firstAttempt))?.status
          ).toBe("active");
          const currentPlans = listUnlimitedAutoRenewals(source.buyerAccountId);
          expect((yield* currentPlans).get(source.id)?.status).toBe("pending");
          if (refunded) {
            yield* db
              .update(paymentAttempts)
              .set({
                refundState: "refunded",
                refundedAmountValue: price.value / 2,
                refundedAt: now,
              })
              .where(eq(paymentAttempts.id, firstAttempt));
          }
          const previousStatus = refunded ? undefined : "pending";

          const successor = yield* recordPurchase(
            now,
            0,
            "reserved-desk",
            true,
            source
          );
          expect(successor).toMatchObject({
            autoRenew: true,
            renewsPassId: source.id,
            validFrom: source.validUntil,
          });
          yield* createUnlimitedPassHolds(successor);
          expect((yield* currentPlans).get(source.id)?.status).toBe(
            previousStatus
          );
          const secondAttempt = yield* paid(successor);
          expect((yield* currentPlans).get(source.id)?.status).toBe(
            previousStatus
          );
          expect((yield* currentPlans).has(successor.id)).toBe(false);

          yield* confirmUnlimitedPassDays(successor);
          expect(
            (yield* settlePassPurchase(successor.id, secondAttempt))?.status
          ).toBe("active");
          expect(
            yield* settlePassPurchase(successor.id, secondAttempt)
          ).toBeUndefined();
          const plans = yield* currentPlans;
          expect(plans.get(source.id)?.status).toBe(
            refunded ? undefined : "cancelled"
          );
          expect(plans.get(successor.id)).toEqual({
            status: "pending",
            nextRenewalOn: successor.validUntil,
            amount: price,
          });
          const [stopped] = yield* db
            .select()
            .from(unlimitedAutoRenewalAuthorizations)
            .where(
              eq(
                unlimitedAutoRenewalAuthorizations.paymentAttemptId,
                firstAttempt
              )
            );
          expect(stopped).toMatchObject({
            prepaidSuccessorOrderId: refunded ? null : successor.id,
            cancelledAt: null,
          });
        }).pipe(
          Effect.provide(
            Layer.merge(servicesFor(provider.service), TestClock.layer())
          )
        )
      );
    } finally {
      renewalPreviewEnabled.mockReturnValue(false);
    }
  }
);

it("recovers a verified capture after an interrupted read of replacement holds", async () => {
  const now = Temporal.Now.instant().round({ smallestUnit: "millisecond" });
  const purchase = await Effect.runPromise(
    recordPurchase(now).pipe(
      Effect.provide(requireTestDatabase(database).layer)
    )
  );
  const services = servicesFor(
    withInterruptedHoldRead({
      ...provider.service,
      getTables: () =>
        Effect.gen(function* () {
          const { attempts, order } = yield* readState(purchase.id).pipe(
            Effect.provide(requireTestDatabase(database).layer)
          );
          expect(attempts[0]).toMatchObject({
            state: "paid",
            refundState: "not_required",
            lastProviderOperationId: "verified-operation",
          });
          expect(order?.paidAt?.toString()).toBe(now.toString());
          return yield* provider.service.getTables();
        }),
    })
  );

  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* WorkspaceDatabase;
      const attemptId = yield* recordAttempt(purchase.id, "expired", now);
      yield* db
        .update(orders)
        .set({ paymentState: "expired", activePaymentAttemptId: attemptId })
        .where(eq(orders.id, purchase.id));
      yield* settlePassPurchase(purchase.id);
      const handler = yield* makeEntryPackOrderPaymentHandler;
      const interrupted = yield* Effect.result(
        handler.startRecovery({
          orderId: purchase.id,
          paymentAttemptId: attemptId,
          providerOperationId: "verified-operation",
          providerStatus: "EXECUTED",
          verifiedPaidAt: now,
        })
      );
      expect(interrupted).toMatchObject({
        failure: { _tag: "DotyposRejected", operation: "getReservationsByIds" },
      });
      const recorded = yield* readState(purchase.id);
      expect(recorded.order?.paymentState).toBe("expired");
      expect(recorded.purchase?.status).toBe("pending_payment");
      const replacementDays = yield* readUnlimitedPassDays(purchase.id);
      expect(
        replacementDays.every(
          ({ reservationState }) => reservationState === "held"
        )
      ).toBe(true);
      expect(yield* reconcileUnlimitedPassReleases({ now, limit: 2 })).toBe(0);

      // A back-office unsolicited partial refund preserves the accepted
      // purchase and must not replace the verified capture timestamp.
      const refundAt = now.add({ minutes: 1 });
      yield* db
        .update(paymentAttempts)
        .set({
          refundState: "refunded",
          refundedAmountValue: 100_000,
          refundedAt: refundAt,
          updatedAt: refundAt,
        })
        .where(eq(paymentAttempts.id, attemptId));

      const registry = OrderPaymentHandlers.make(
        { "pass-purchase": handler },
        () => Effect.succeed("pass-purchase")
      );
      expect(
        yield* reconcilePassPurchases({
          now: now.add({ minutes: 6 }),
          limit: 1,
        }).pipe(Effect.provideService(OrderPaymentHandlers, registry))
      ).toMatchObject({ recoveriesRetried: 1 });
      const recovered = yield* readState(purchase.id);
      expect(recovered.order?.paymentState).toBe("paid");
      expect(recovered.order?.paidAt?.toString()).toBe(now.toString());
      expect(recovered.purchase?.status).toBe("active");
      expect(recovered.attempts[0]).toMatchObject({
        refundState: "refunded",
        refundedAmountValue: 100_000,
        refundTargetValue: null,
      });
      const confirmed = yield* readUnlimitedPassDays(purchase.id);
      expect(confirmed.map(({ reservationState }) => reservationState)).toEqual(
        Array(unlimitedPassDays).fill("confirmed")
      );
      expect(
        confirmed.map(({ dotyposReservationId }) => dotyposReservationId)
      ).toEqual(
        replacementDays.map(({ dotyposReservationId }) => dotyposReservationId)
      );
    }).pipe(Effect.provide(services))
  );
});

it("requires a full refund for a verified superseded attempt without touching the winning attempt", async () => {
  const now = Temporal.Now.instant();
  const initialRecords = provider.reservations.size;
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* WorkspaceDatabase;
      const purchase = yield* recordPurchase(now);
      const oldId = yield* recordAttempt(purchase.id, "expired", now);
      const newId = yield* recordAttempt(purchase.id, "expired", now);
      yield* db
        .update(orders)
        .set({ paymentState: "expired", activePaymentAttemptId: newId })
        .where(eq(orders.id, purchase.id));
      yield* settlePassPurchase(purchase.id);
      const handler = yield* makeEntryPackOrderPaymentHandler;
      yield* handler.startRecovery({
        orderId: purchase.id,
        paymentAttemptId: oldId,
        providerOperationId: "late-old-operation",
        verifiedPaidAt: now,
      });
      const recovered = yield* readState(purchase.id);
      expect(recovered.order).toMatchObject({
        paymentState: "expired",
        activePaymentAttemptId: newId,
      });
      expect(recovered.attempts.find(({ id }) => id === oldId)).toMatchObject({
        state: "paid",
        refundState: "required",
        refundTargetValue: price.value,
      });
      expect(recovered.attempts.find(({ id }) => id === newId)?.state).toBe(
        "expired"
      );
      expect(provider.reservations.size).toBe(initialRecords);
    }).pipe(Effect.provide(servicesFor(provider.service)))
  );
});

it("preserves legacy full refund obligations after a partial refund record", async () => {
  const now = Temporal.Now.instant();
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* WorkspaceDatabase;
      const purchase = yield* recordPurchase(now, 225);
      const attemptId = yield* recordAttempt(purchase.id, "paid", now);
      yield* db
        .update(orders)
        .set({
          paymentState: "expired",
          activePaymentAttemptId: attemptId,
        })
        .where(eq(orders.id, purchase.id));
      yield* settlePassPurchase(purchase.id);
      yield* db
        .update(paymentAttempts)
        .set({
          refundState: "refunded",
          refundedAmountValue: 100_000,
          refundedAt: now,
        })
        .where(eq(paymentAttempts.id, attemptId));
      const recordsBefore = provider.reservations.size;
      const handler = yield* makeEntryPackOrderPaymentHandler;
      const registry = OrderPaymentHandlers.make(
        { "pass-purchase": handler },
        () => Effect.succeed("pass-purchase")
      );
      expect(
        yield* reconcilePassPurchases({
          now: now.add({ minutes: 6 }),
          limit: 1,
        }).pipe(Effect.provideService(OrderPaymentHandlers, registry))
      ).toMatchObject({ recoveriesRetried: 1 });
      const rejected = yield* readState(purchase.id);
      expect(rejected.order).toMatchObject({
        paymentState: "expired",
        paidAt: null,
      });
      expect(rejected.purchase?.status).toBe("void");
      expect(rejected.attempts[0]).toMatchObject({
        state: "paid",
        refundState: "required",
        refundTargetValue: price.value,
        refundedAmountValue: 100_000,
      });
      expect(provider.reservations.size).toBe(recordsBefore);
    }).pipe(Effect.provide(servicesFor(provider.service)))
  );
});

it("requires a full refund when the original holder cannot be readmitted", async () => {
  const now = Temporal.Now.instant();
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* WorkspaceDatabase;
      const purchase = yield* recordPurchase(now, 90);
      const attemptId = yield* recordAttempt(purchase.id, "expired", now);
      yield* db
        .update(orders)
        .set({ paymentState: "expired", activePaymentAttemptId: attemptId })
        .where(eq(orders.id, purchase.id));
      yield* settlePassPurchase(purchase.id);
      yield* db
        .update(customerAccounts)
        .set({ deletedAt: now })
        .where(eq(customerAccounts.id, purchase.holderAccountId));
      const recordsBefore = provider.reservations.size;
      const handler = yield* makeEntryPackOrderPaymentHandler;
      yield* handler.startRecovery({
        orderId: purchase.id,
        paymentAttemptId: attemptId,
        verifiedPaidAt: now,
      });
      const rejected = yield* readState(purchase.id);
      expect(rejected.order?.paymentState).toBe("expired");
      expect(rejected.purchase?.status).toBe("void");
      expect(rejected.attempts[0]).toMatchObject({
        state: "paid",
        refundState: "required",
        refundTargetValue: price.value,
      });
      expect(provider.reservations.size).toBe(recordsBefore);
    }).pipe(Effect.provide(servicesFor(provider.service)))
  );
});

it("requires a full refund when the holder is deleted after replacement holds are stored", async () => {
  const now = Temporal.Now.instant();
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* WorkspaceDatabase;
      const purchase = yield* recordPurchase(now, 150);
      const attemptId = yield* recordAttempt(purchase.id, "expired", now);
      yield* db
        .update(orders)
        .set({
          paymentState: "expired",
          activePaymentAttemptId: attemptId,
        })
        .where(eq(orders.id, purchase.id));
      yield* settlePassPurchase(purchase.id);
      const handler = yield* makeEntryPackOrderPaymentHandler;
      const interrupted = yield* Effect.result(
        handler.startRecovery({
          orderId: purchase.id,
          paymentAttemptId: attemptId,
          verifiedPaidAt: now,
        })
      );
      expect(interrupted).toMatchObject({
        failure: { _tag: "DotyposRejected", operation: "getReservationsByIds" },
      });
      const replacementDays = yield* readUnlimitedPassDays(purchase.id);
      expect(replacementDays).toHaveLength(unlimitedPassDays);
      expect(
        replacementDays.every(
          ({ reservationState }) => reservationState === "held"
        )
      ).toBe(true);

      yield* db
        .update(customerAccounts)
        .set({ deletedAt: now })
        .where(eq(customerAccounts.id, purchase.holderAccountId));
      const resumed = yield* Effect.result(
        handler.resumeRecovery({
          orderId: purchase.id,
          paymentAttemptId: attemptId,
        })
      );
      const rejected = yield* readState(purchase.id);
      expect(rejected.order?.paymentState).toBe("expired");
      expect(rejected.purchase?.status).toBe("void");
      expect(rejected.attempts[0]).toMatchObject({
        state: "paid",
        refundState: "required",
        refundTargetValue: price.value,
      });
      expect(resumed).toMatchObject({ success: true });

      yield* reconcileUnlimitedPassReleases({ now, limit: 2 });
      expect(
        (yield* readUnlimitedPassDays(purchase.id)).every(
          ({ reservationState }) => reservationState === "cancelled"
        )
      ).toBe(true);
    }).pipe(
      Effect.provide(servicesFor(withInterruptedHoldRead(provider.service)))
    )
  );
});

for (const tier of ["open-space", "reserved-desk"] as const) {
  it(`requires a full refund when the first ${tier} service day ends during recovery`, async () => {
    const start = getCurrentWorkspaceDate().add({ days: 190 });
    const endsAt = Temporal.Instant.from(
      getCoworkReservationInterval(tier, start.toString()).endsAt
    );
    const beforeClosing = endsAt.subtract({ minutes: 2 });
    const services = servicesFor({
      ...provider.service,
      getReservationsByIds: (ids, options) =>
        provider.service
          .getReservationsByIds(ids, options)
          .pipe(Effect.tap(() => TestClock.setTime(endsAt.epochMilliseconds))),
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(beforeClosing.epochMilliseconds);
        const { db } = yield* WorkspaceDatabase;
        const purchase = yield* recordPurchase(beforeClosing, 0, tier);
        const attemptId = yield* recordAttempt(
          purchase.id,
          "expired",
          beforeClosing
        );
        yield* createUnlimitedPassHolds(purchase);
        yield* db
          .update(orders)
          .set({
            paymentState: "expired",
            activePaymentAttemptId: attemptId,
          })
          .where(eq(orders.id, purchase.id));
        const handler = yield* makeEntryPackOrderPaymentHandler;
        yield* handler.startRecovery({
          orderId: purchase.id,
          paymentAttemptId: attemptId,
          verifiedPaidAt: beforeClosing,
        });
        const rejected = yield* readState(purchase.id);
        expect(rejected.order?.paymentState).toBe("expired");
        expect(rejected.purchase?.status).toBe("void");
        expect(rejected.attempts[0]).toMatchObject({
          state: "paid",
          refundState: "required",
          refundTargetValue: price.value,
        });
        yield* reconcileUnlimitedPassReleases({ now: endsAt, limit: 2 });
      }).pipe(Effect.provide(Layer.merge(services, TestClock.layer())))
    );
  });
}

it("rechecks the first service day before activation after provider confirmation", async () => {
  const start = getCurrentWorkspaceDate().add({ days: 265 });
  const endsAt = Temporal.Instant.from(
    getCoworkReservationInterval("open-space", start.toString()).endsAt
  );
  const beforeClosing = endsAt.subtract({ minutes: 2 });
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* WorkspaceDatabase;
      yield* TestClock.setTime(beforeClosing.epochMilliseconds);
      const purchase = yield* recordPurchase(beforeClosing, 0, "open-space");
      const paidId = yield* recordAttempt(purchase.id, "paid", beforeClosing);
      yield* createUnlimitedPassHolds(purchase);
      yield* db
        .update(orders)
        .set({
          paymentState: "paid",
          activePaymentAttemptId: paidId,
          paidAt: beforeClosing,
        })
        .where(eq(orders.id, purchase.id));
      yield* settlePassPurchase(purchase.id);
      yield* confirmUnlimitedPassDays(purchase);
      yield* TestClock.setTime(endsAt.epochMilliseconds);

      expect(yield* settlePassPurchase(purchase.id, paidId)).toBeUndefined();
      const rejected = yield* readState(purchase.id);
      expect(rejected.purchase?.status).toBe("void");
      expect(rejected.order?.fulfillmentState).toBe("failed");
      expect(rejected.attempts[0]).toMatchObject({
        refundState: "required",
        refundTargetValue: price.value,
      });
      yield* reconcileUnlimitedPassReleases({ now: endsAt, limit: 2 });
    }).pipe(
      Effect.provide(
        Layer.merge(servicesFor(provider.service), TestClock.layer())
      )
    )
  );
});

it("requires a full refund if the holder is tombstoned during provider confirmation", async () => {
  const now = Temporal.Now.instant();
  const purchase = await Effect.runPromise(
    recordPurchase(now, 425).pipe(
      Effect.provide(requireTestDatabase(database).layer)
    )
  );
  const tombstoneHolder = Effect.gen(function* () {
    const { db } = yield* WorkspaceDatabase;
    yield* db
      .update(customerAccounts)
      .set({ deletedAt: now })
      .where(eq(customerAccounts.id, purchase.holderAccountId));
  }).pipe(Effect.provide(requireTestDatabase(database).layer), Effect.orDie);
  let confirmations = 0;
  const services = servicesFor({
    ...provider.service,
    confirmReservation: (id) =>
      provider.service.confirmReservation(id).pipe(
        Effect.tap(() => {
          confirmations++;
          return confirmations === 1 ? tombstoneHolder : Effect.void;
        })
      ),
  });

  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* WorkspaceDatabase;
      const attemptId = yield* recordAttempt(purchase.id, "paid", now);
      yield* createUnlimitedPassHolds(purchase);
      yield* db
        .update(orders)
        .set({
          paymentState: "paid",
          activePaymentAttemptId: attemptId,
          paidAt: now,
        })
        .where(eq(orders.id, purchase.id));
      yield* settlePassPurchase(purchase.id);

      const handler = yield* makeEntryPackOrderPaymentHandler;
      yield* handler.fulfill(purchase.id);

      expect(confirmations).toBe(unlimitedPassDays);
      const rejected = yield* readState(purchase.id);
      expect(rejected.purchase?.status).toBe("void");
      expect(rejected.order).toMatchObject({
        paymentState: "paid",
        fulfillmentState: "failed",
        fulfillmentFailureCode: "unlimited_pass_holder_unavailable",
      });
      expect(rejected.attempts[0]).toMatchObject({
        refundState: "required",
        refundTargetValue: price.value,
      });
      yield* reconcileUnlimitedPassReleases({ now, limit: 2 });
      expect(
        (yield* readUnlimitedPassDays(purchase.id)).every(
          ({ reservationState }) => reservationState === "cancelled"
        )
      ).toBe(true);
    }).pipe(Effect.provide(services))
  );
});

for (const timing of ["before", "during"] as const) {
  it(`requires a full refund when the first day closes ${timing} a failing confirmation`, async () => {
    const start = getCurrentWorkspaceDate().add({ days: 300 });
    const endsAt = Temporal.Instant.from(
      getCoworkReservationInterval("open-space", start.toString()).endsAt
    );
    const beforeClosing = endsAt.subtract({ minutes: 2 });
    let confirmations = 0;
    const services = servicesFor({
      ...provider.service,
      confirmReservation: () =>
        Effect.gen(function* () {
          confirmations += 1;
          yield* TestClock.setTime(endsAt.epochMilliseconds);
          return yield* new DotyposRejected({
            operation: "confirmReservation",
            reason: "invalid-response",
          });
        }),
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* WorkspaceDatabase;
        yield* TestClock.setTime(beforeClosing.epochMilliseconds);
        const purchase = yield* recordPurchase(beforeClosing, 0, "open-space");
        const attemptId = yield* recordAttempt(
          purchase.id,
          "paid",
          beforeClosing
        );
        yield* createUnlimitedPassHolds(purchase);
        yield* db
          .update(orders)
          .set({
            paymentState: "paid",
            activePaymentAttemptId: attemptId,
            paidAt: beforeClosing,
          })
          .where(eq(orders.id, purchase.id));
        yield* settlePassPurchase(purchase.id);
        if (timing === "before")
          yield* TestClock.setTime(endsAt.epochMilliseconds);
        const handler = yield* makeEntryPackOrderPaymentHandler;
        const fulfillment = yield* Effect.result(handler.fulfill(purchase.id));

        const rejected = yield* readState(purchase.id);
        expect(rejected.purchase?.status).toBe("void");
        expect(rejected.order?.fulfillmentState).toBe("failed");
        expect(rejected.attempts[0]).toMatchObject({
          refundState: "required",
          refundTargetValue: price.value,
        });
        expect(confirmations > 0).toBe(timing === "during");
        expect(fulfillment).toMatchObject({ _tag: "Success" });
        yield* reconcileUnlimitedPassReleases({ now: endsAt, limit: 2 });
      }).pipe(Effect.provide(Layer.merge(services, TestClock.layer())))
    );
  });
}

it("rechecks a refund recorded after provider confirmation before first activation", async () => {
  const now = Temporal.Now.instant();
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* WorkspaceDatabase;
      const purchase = yield* recordPurchase(now, 45);
      const paidId = yield* recordAttempt(purchase.id, "paid", now);
      yield* createUnlimitedPassHolds(purchase);
      yield* db
        .update(orders)
        .set({
          paymentState: "paid",
          activePaymentAttemptId: paidId,
          paidAt: now,
        })
        .where(eq(orders.id, purchase.id));
      yield* settlePassPurchase(purchase.id);
      expect(yield* canConfirmUnlimitedPass(purchase.id, paidId)).toBe(true);
      yield* confirmUnlimitedPassDays(purchase);
      yield* db
        .update(paymentAttempts)
        .set({
          refundState: "refunded",
          refundedAmountValue: price.value,
          refundedAt: now,
        })
        .where(eq(paymentAttempts.id, paidId));

      expect(yield* settlePassPurchase(purchase.id, paidId)).toBeUndefined();
      const ended = yield* readState(purchase.id);
      expect(ended.purchase?.status).toBe("void");
      expect(ended.order?.fulfillmentState).toBe("failed");
      yield* reconcileUnlimitedPassReleases({ now, limit: 2 });
      expect(
        (yield* readUnlimitedPassDays(purchase.id)).every(
          (day) =>
            day.dotyposReservationId !== null &&
            provider.reservations.get(day.dotyposReservationId)?.status ===
              "CANCELLED"
        )
      ).toBe(true);
    }).pipe(Effect.provide(servicesFor(provider.service)))
  );
});

const assertReceiptReplay = async (
  adjustment: "validity" | "validity and holder"
) => {
  const reassigned = adjustment === "validity and holder";
  const fixture = reassigned ? "reassigned" : "shortened";
  const now = Temporal.Now.instant();
  const buyerEmail = testEmailAddress(`cancelled-unlimited-buyer-${fixture}`);
  const holderEmail = testEmailAddress(`cancelled-unlimited-holder-${fixture}`);
  const invoiceId = invoiceIdSchema.make(crypto.randomUUID());
  const acceptance = {
    id: EmailDeliveryIdSchema.make(crypto.randomUUID()),
    status: "sent" as const,
    provider: "fixture",
    timestamp: new Date(),
  };
  const accepted = new Map<string, string>();
  const confirmation = mock<typeof EmailServiceTag.Service.send>((message) => {
    const key = message.idempotencyKey;
    if (!key) return Effect.fail(new EmailServiceError("Missing fixture key."));
    const payload = JSON.stringify(message);
    const previous = accepted.get(key);
    if (previous !== undefined && previous !== payload)
      return Effect.fail(
        new EmailServiceError("Synthetic idempotency conflict.")
      );
    if (previous === undefined) accepted.set(key, payload);
    return Effect.succeed(acceptance);
  });
  const deliverInvoice = mock(() =>
    Effect.succeed({ status: "delivered" as const, changed: true })
  );

  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* WorkspaceDatabase;
      const purchase = yield* recordPurchase(now, reassigned ? 380 : 345);
      const holderAccountId = customerAccountIdSchema.make(crypto.randomUUID());
      yield* db.insert(customerAccounts).values({
        id: holderAccountId,
        dotyposCustomerId: reassigned ? customerId : null,
      });
      yield* db.insert(authUser).values([
        {
          id: purchase.buyerAccountId,
          email: buyerEmail,
          name: "Synthetic Buyer",
          emailVerified: true,
        },
        {
          id: holderAccountId,
          email: holderEmail,
          name: "Synthetic Holder",
          emailVerified: true,
        },
      ]);
      yield* db
        .update(passPurchases)
        .set({ holderAccountId })
        .where(eq(passPurchases.id, purchase.id));
      const attemptId = yield* recordAttempt(purchase.id, "paid", now);
      yield* createUnlimitedPassHolds(purchase);
      yield* db
        .update(orders)
        .set({
          paymentState: "paid",
          activePaymentAttemptId: attemptId,
          paidAt: now,
        })
        .where(eq(orders.id, purchase.id));
      yield* settlePassPurchase(purchase.id);
      yield* confirmUnlimitedPassDays(purchase);
      const active = yield* settlePassPurchase(purchase.id, attemptId);
      expect(active).toMatchObject({ status: "active", holderAccountId });
      expect(active?.giftIssuedAt).not.toBeNull();
      yield* db
        .update(entryPackGiftInvitations)
        .set({
          nextAttemptAt: now.add({ minutes: 10 }),
          confirmationInvited: !reassigned,
        })
        .where(eq(entryPackGiftInvitations.orderId, purchase.id));

      const quote = yield* Schema.decodeEffect(passPurchaseQuoteCodec)(
        purchase.quote
      );
      const issueInvoice = mock<
        typeof InvoiceRepository.Service.issueEntryPack
      >(() => Effect.succeed(invoiceId));
      const invoiceUnavailable = () =>
        Effect.fail(
          new AccountingRecordUnavailable({
            operation: "load",
            reference: { type: "paymentAttemptId", id: attemptId },
            message: "Synthetic invoice issuance failure.",
          })
        );
      issueInvoice
        .mockImplementationOnce(invoiceUnavailable)
        .mockImplementationOnce(invoiceUnavailable);
      const handler = yield* makeEntryPackOrderPaymentHandler.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(AccountingDocumentSnapshots, {
              findPassPurchase: () =>
                Effect.succeed({
                  orderId: purchase.id,
                  dotyposCustomerId: customerId,
                  locale: purchase.locale,
                  serviceDate: purchase.validFrom,
                  supplier: workspaceAccountingSupplier,
                  buyer: { kind: "person", legalName: "Synthetic Buyer" },
                  billing: {
                    purpose: "personal",
                    invoice: "requested",
                    address: {
                      line1: "Synthetic Street 1",
                      city: "Praha",
                      postalCode: "180 00",
                      country: "CZ",
                    },
                  },
                  delivery: { email: buyerEmail },
                  product: { kind: "unlimited", tier: "reserved-desk" },
                  quote,
                }),
            }),
            Layer.mock(EmailConfigTag, {
              defaultFrom: { email: buyerEmail },
            }),
            Layer.mock(EmailServiceTag, { send: confirmation }),
            Layer.mock(InvoiceRepository, { issueEntryPack: issueInvoice }),
            Layer.mock(InvoiceEmailDeliveryService, {
              deliverByInvoiceId: deliverInvoice,
            }),
            Layer.mock(InvoiceEmailDeliveryRepository, {
              status: () =>
                Effect.succeed(
                  new Map([
                    [
                      invoiceId,
                      {
                        customer: "accepted",
                        internal: "accepted",
                        needsAttention: false,
                        sentTo: ["customer", "internal"],
                      },
                    ],
                  ])
                ),
            })
          )
        )
      );

      yield* Effect.promise(() =>
        requireTestDatabase(database).pool.query(`
        create function reject_receipt_acknowledgment() returns trigger
        language plpgsql as $$
        begin
          if new.fulfillment_state = 'awaiting_delivery' then
            raise exception 'fixture receipt acknowledgment failure';
          end if;
          return new;
        end;
        $$;
        create trigger reject_receipt_acknowledgment before update on orders
        for each row execute function reject_receipt_acknowledgment();
      `)
      );
      const interrupted = yield* Effect.result(
        handler.fulfill(purchase.id).pipe(
          Effect.ensuring(
            Effect.promise(() =>
              requireTestDatabase(database).pool.query(
                `drop trigger reject_receipt_acknowledgment on orders;
                   drop function reject_receipt_acknowledgment();`
              )
            )
          )
        )
      );
      expect(interrupted._tag).toBe("Failure");
      expect(confirmation).toHaveBeenCalledTimes(1);
      expect((yield* readState(purchase.id)).order?.fulfillmentState).toBe(
        "not_started"
      );

      const start = Temporal.PlainDate.from(purchase.validFrom);
      const validUntil = date(start.add({ days: 7 }));
      const adjust = (
        change: Parameters<typeof beginUnlimitedPassChange>[0]["change"]
      ) =>
        beginUnlimitedPassChange({
          passId: purchase.id,
          requestId: crypto.randomUUID(),
          reason: "Synthetic pass adjustment",
          change,
        }).pipe(
          Effect.provideService(CurrentAdministrator, {
            accountId: purchase.buyerAccountId,
            email: buyerEmail,
          }),
          Effect.flatMap(completePassChange),
          Effect.tap((record) =>
            Effect.sync(() => expect(record.completedAt).not.toBeNull())
          )
        );
      yield* adjust({
        _tag: "validity",
        expectedValidUntil: purchase.validUntil,
        lastDay: date(start.add({ days: 6 })),
        refundValue: 0,
      });
      if (reassigned) {
        const buyerHolderCustomerId = DotyposCustomerIdSchema.make("97641");
        yield* db
          .update(customerAccounts)
          .set({ dotyposCustomerId: buyerHolderCustomerId })
          .where(eq(customerAccounts.id, purchase.buyerAccountId));
        yield* db
          .update(entryPackGiftInvitations)
          .set({
            sentAt: now,
            nextAttemptAt: null,
            keyId: sealedStateKeyIdSchema.make("fixture"),
          })
          .where(eq(entryPackGiftInvitations.orderId, purchase.id));
        for (const [replacementHolderId, replacementCustomerId] of [
          [purchase.buyerAccountId, buyerHolderCustomerId],
          [holderAccountId, customerId],
          [purchase.buyerAccountId, buyerHolderCustomerId],
        ] as const) {
          const { purchase: current } = yield* readState(purchase.id);
          if (!current) throw new Error("Missing fixture purchase");
          yield* adjust({
            _tag: "reassign",
            expectedHolderAccountId: current.holderAccountId,
            expectedHolderVersion: current.holderVersion,
            holderAccountId: replacementHolderId,
            holderCustomerId: replacementCustomerId,
          });
        }
      }
      yield* adjust({
        _tag: "cancel",
        expectedValidUntil: validUntil,
        refundValue: 0,
        sendCancellationEmail: false,
      });
      const cancelled = {
        status: "cancelled",
        accessEndsOn: purchase.validFrom,
      } as const;
      const released = yield* readUnlimitedPassDays(purchase.id);
      expect(released).toHaveLength(unlimitedPassDays);
      expect(
        released.every((day) => day.reservationState === "cancelled")
      ).toBe(true);

      const expiredAttemptId = yield* recordAttempt(
        purchase.id,
        "expired",
        now
      );
      yield* db
        .update(orders)
        .set({ activePaymentAttemptId: expiredAttemptId })
        .where(eq(orders.id, purchase.id));
      const unverified = yield* Effect.result(handler.fulfill(purchase.id));
      expect(unverified).toMatchObject({
        _tag: "Failure",
        failure: {
          message: "Cancelled Unlimited pass has no active paid attempt.",
        },
      });
      expect(confirmation).toHaveBeenCalledTimes(1);
      expect(issueInvoice).toHaveBeenCalledTimes(1);
      yield* db
        .update(orders)
        .set({ activePaymentAttemptId: attemptId })
        .where(eq(orders.id, purchase.id));

      const first = yield* Effect.result(handler.fulfill(purchase.id));
      expect(first).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "AccountingRecordUnavailable" },
      });
      const [[originalReceipt], [replayedReceipt]] = confirmation.mock.calls;
      expect(originalReceipt?.html?.includes(holderEmail)).toBe(true);
      expect(
        JSON.stringify(replayedReceipt) === JSON.stringify(originalReceipt)
      ).toBe(true);
      expect((yield* readState(purchase.id)).order?.fulfillmentState).toBe(
        "awaiting_delivery"
      );
      yield* handler.fulfill(purchase.id);
      yield* handler.fulfill(purchase.id);

      const state = yield* readState(purchase.id);
      expect(state.order).toMatchObject({
        paymentState: "paid",
        fulfillmentState: "fulfilled",
      });
      expect(state.purchase).toMatchObject({
        ...cancelled,
        validUntil,
        ...(reassigned
          ? {
              holderAccountId: purchase.buyerAccountId,
              holderVersion: 3,
              giftIssuedAt: null,
            }
          : { holderAccountId, giftIssuedAt: active?.giftIssuedAt }),
      });
      expect(yield* readUnlimitedPassDays(purchase.id)).toEqual(released);
      const [invitation] = yield* db
        .select()
        .from(entryPackGiftInvitations)
        .where(eq(entryPackGiftInvitations.orderId, purchase.id));
      expect(invitation).toMatchObject({
        nextAttemptAt: null,
        confirmationInvited: !reassigned,
      });
      expect(confirmation).toHaveBeenCalledTimes(2);
      expect(accepted.size).toBe(1);
      expect(confirmation).toHaveBeenCalledWith(
        expect.objectContaining({
          to: { email: buyerEmail },
          idempotencyKey: `entry-pack-purchase:${purchase.id}`,
        })
      );
      expect(issueInvoice).toHaveBeenCalledTimes(3);
      expect(issueInvoice).toHaveBeenCalledWith({
        orderId: purchase.id,
        paymentAttemptId: attemptId,
      });
      expect(deliverInvoice).toHaveBeenCalledTimes(1);
    }).pipe(
      Effect.provide(
        Layer.merge(
          servicesFor(provider.service),
          Layer.mock(ReservationAdministrationService, {})
        )
      )
    )
  );
};

it.each(["validity", "validity and holder"] as const)(
  "replays the accepted buyer receipt after changing Unlimited %s and cancelling",
  assertReceiptReplay
);

it("rolls back failed expiry settlement and repairs an already split expiry on the next run", async () => {
  const now = Temporal.Now.instant();
  const old = now.subtract({ hours: 1 });
  const services = servicesFor(provider.service);
  const { first, split } = await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* WorkspaceDatabase;
      const first = yield* recordPurchase(old, 70);
      const split = yield* recordPurchase(old, 105);
      yield* db
        .update(orders)
        .set({ paymentState: "expired" })
        .where(eq(orders.id, split.id));
      return { first, split };
    }).pipe(Effect.provide(services))
  );
  await requireTestDatabase(database).pool.query(`
    create function reject_unlimited_expiry() returns trigger
    language plpgsql as $$
    begin
      if new.status = 'void' then
        raise exception 'fixture expiry settlement failure';
      end if;
      return new;
    end;
    $$;
    create trigger reject_unlimited_expiry before update on pass_purchases
    for each row execute function reject_unlimited_expiry();
  `);
  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      WorkspaceDatabase | DotyposService | WorkspaceDatabaseAdvisoryLock
    >
  ) => Effect.runPromise(effect.pipe(Effect.provide(services)));
  try {
    await run(reconcileUnlimitedPassReleases({ now, limit: 2 }));
    const unpaid = await run(readState(first.id));
    expect(unpaid.order?.paymentState).toBe("not_started");
    expect(unpaid.purchase?.status).toBe("pending_payment");
    const interrupted = await run(readState(split.id));
    expect(interrupted.order?.paymentState).toBe("expired");
    expect(interrupted.purchase?.status).toBe("pending_payment");
  } finally {
    await requireTestDatabase(database).pool.query(
      "drop trigger reject_unlimited_expiry on pass_purchases"
    );
  }
  expect(await run(reconcileUnlimitedPassReleases({ now, limit: 2 }))).toBe(2);
  for (const purchase of [first, split]) {
    expect((await run(readState(purchase.id))).purchase?.status).toBe("void");
    expect(
      (await run(readUnlimitedPassDays(purchase.id))).every(
        (day) =>
          day.paymentState === "expired" &&
          day.reservationState === "hold_expired"
      )
    ).toBe(true);
  }
});

it("reconciles only the service dates after access ends on a withdrawn pass", async () => {
  const now = Temporal.Now.instant();
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* WorkspaceDatabase;
      const purchase = yield* recordPurchase(now, 0);
      const paidId = yield* recordAttempt(purchase.id, "paid", now);
      yield* createUnlimitedPassHolds(purchase);
      yield* db
        .update(orders)
        .set({
          paymentState: "paid",
          activePaymentAttemptId: paidId,
          paidAt: now,
        })
        .where(eq(orders.id, purchase.id));
      yield* settlePassPurchase(purchase.id);
      yield* confirmUnlimitedPassDays(purchase);
      expect((yield* settlePassPurchase(purchase.id, paidId))?.status).toBe(
        "active"
      );
      yield* db
        .update(passPurchases)
        .set({
          status: "withdrawn",
          accessEndsOn: date(getCurrentWorkspaceDate(now).add({ days: 1 })),
        })
        .where(eq(passPurchases.id, purchase.id));
      yield* db
        .update(paymentAttempts)
        .set({ refundState: "required", refundTargetValue: 100_000 })
        .where(eq(paymentAttempts.id, paidId));

      expect(yield* reconcileUnlimitedPassReleases({ now, limit: 2 })).toBe(1);
      expect(yield* reconcileUnlimitedPassReleases({ now, limit: 2 })).toBe(0);
      const days = yield* readUnlimitedPassDays(purchase.id);
      expect(days[0]?.reservationState).toBe("confirmed");
      expect(
        days
          .slice(1)
          .every(({ reservationState }) => reservationState === "cancelled")
      ).toBe(true);
      expect((yield* readState(purchase.id)).purchase?.status).toBe(
        "withdrawn"
      );
    }).pipe(Effect.provide(servicesFor(provider.service)))
  );
});
