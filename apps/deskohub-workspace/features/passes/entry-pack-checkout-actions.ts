"use server";

import { Effect, Layer, Option, Schema } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { CurrentCustomerAccount } from "@/features/account/backend/current-customer-account";
import { CustomerAccountContactService } from "@/features/account/backend/customer-account-contact.service";
import { CustomerAccountSections } from "@/features/account/backend/customer-account-sections";
import { CustomerAccountAccessError } from "@/features/account/customer-account";
import { AccountingDocumentSnapshots } from "@/features/accounting/backend/accounting-document-snapshots";
import { AccountingSnapshotKeyService } from "@/features/accounting/backend/accounting-snapshot-key.service";
import { CheckoutAnalytics } from "@/features/checkout/backend/analytics/checkout-analytics.service";
import { checkoutSubmitDeadline } from "@/features/checkout/backend/checkout/checkout-submit-deadline";
import { LatePaymentVerificationService } from "@/features/checkout/backend/payment/late-payment-verification.service";
import { OrderPaymentHandlers } from "@/features/checkout/backend/payment/order-payment-handlers.service";
import { PaymentProvidersLive } from "@/features/checkout/backend/payment/payment-providers";
import { LegalEvidenceEventRepository } from "@/features/checkout/backend/repositories/legal-evidence-event.repository";
import { canonicalPromotionCodeSchema } from "@/features/discounts/contracts";
import { DiscountService } from "@/features/discounts/discount.service";
import { normalizeSubmittedPromotionCode } from "@/features/discounts/promotion-code";
import { WorkspaceFeatureFlagService } from "@/features/feature-flags/backend/workspace-feature-flag.service";
import { orderIdSchema } from "@/features/order";
import { ReferralService } from "@/features/referrals";
import { ReferralReleaseGateRequest } from "@/features/referrals/referral-release-gate.server";
import { RememberedReferral } from "@/features/referrals/remembered-referral.service";
import { defineWorkspaceAction } from "@/shared/backend/workspace-action";
import { runWorkspaceEffectOrElse } from "@/shared/backend/workspace-effect";
import type { ResolveIssuedActionLocale } from "@/shared/utils/action-middleware/locale";
import { readOwnedEntryPackOrderLocale } from "./backend/entry-pack-order";
import {
  beginEntryPackPurchase,
  displayEntryPackCheckoutPrice,
  EntryPackPurchaseError,
  getEntryPackPaymentDisclosure,
  payForEntryPack,
  repriceEntryPackPurchase,
} from "./backend/entry-pack-purchase";
import {
  beginEntryPackCheckoutSchema,
  payEntryPackCheckoutSchema,
  repriceEntryPackCheckoutSchema,
} from "./entry-pack-checkout";
import { entryPackPurchaseQuoteCodec } from "./entry-pack-purchase-quote";
import { getEntryPackLastUsableDate } from "./pass-offer";

const purchaseLayer = Layer.mergeAll(
  WorkspaceDatabase.Default,
  CurrentCustomerAccount.Live,
  CustomerAccountContactService.Live,
  CustomerAccountSections.Live,
  WorkspaceFeatureFlagService.Default,
  DiscountService.Live,
  RememberedReferral.Cookies.pipe(
    Layer.provide(
      Layer.mergeAll(ReferralService.Live, CurrentCustomerAccount.Live)
    )
  )
).pipe(Layer.provide(ReferralReleaseGateRequest));

const payLayer = Layer.mergeAll(
  purchaseLayer,
  AccountingDocumentSnapshots.Default.pipe(
    Layer.provide(
      Layer.mergeAll(
        WorkspaceDatabase.Default,
        AccountingSnapshotKeyService.Default
      )
    )
  ),
  OrderPaymentHandlers.Live,
  LatePaymentVerificationService.Live,
  LegalEvidenceEventRepository.Live,
  CheckoutAnalytics.Live,
  PaymentProvidersLive
);

const readActionOrder = Schema.decodeUnknownOption(
  Schema.Struct({ orderId: orderIdSchema })
);

const resolveIssuedOrderLocale: ResolveIssuedActionLocale = async (
  clientInput
) => {
  const order = readActionOrder(clientInput);
  if (Option.isNone(order)) return undefined;

  return readOwnedEntryPackOrderLocale(order.value.orderId).pipe(
    Effect.provide(
      Layer.mergeAll(WorkspaceDatabase.Default, CurrentCustomerAccount.Live)
    ),
    runWorkspaceEffectOrElse("passes.action-order-locale", {
      boundary: "action",
      failureCode: "entry_pack_order_locale_unavailable",
      orElse: () => undefined,
    })
  );
};

const readReferralCode = Effect.gen(function* () {
  const remembered = yield* RememberedReferral;
  return Option.getOrUndefined(
    Schema.decodeUnknownOption(canonicalPromotionCodeSchema)(
      yield* remembered.code
    )
  );
});

const purchaseFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is E & EntryPackPurchaseError =>
        error instanceof EntryPackPurchaseError,
      ({ reason, locale }) =>
        Effect.succeed(
          reason === "terms-changed" && locale
            ? {
                status: "terms_changed" as const,
                disclosure: getEntryPackPaymentDisclosure(locale),
              }
            : { status: "purchase_error" as const, reason }
        )
    ),
    Effect.catchIf(
      (error): error is typeof error & CustomerAccountAccessError =>
        error instanceof CustomerAccountAccessError,
      () => Effect.succeed({ status: "signed_out" as const })
    )
  );

const beginAction = defineWorkspaceAction(
  {
    operation: "passes.begin-entry-pack-checkout",
    schema: (locale) =>
      Schema.toStandardSchemaV1(beginEntryPackCheckoutSchema(locale)),
    deadline: checkoutSubmitDeadline,
    logInput: false,
  },
  (input) =>
    purchaseFailure(
      Effect.gen(function* () {
        const account = yield* CurrentCustomerAccount;
        const session = yield* account.requireActive;
        if (session.email.toLowerCase() !== input.buyerEmail.toLowerCase()) {
          return { status: "signed_out" as const };
        }
        const referralCode = yield* readReferralCode;
        const purchase = yield* beginEntryPackPurchase({
          ...input,
          ...(referralCode && { referralCode }),
        });
        const quote = yield* Schema.decodeEffect(entryPackPurchaseQuoteCodec)(
          purchase.quote
        );
        return {
          status: "ready" as const,
          product: {
            kind: "entry-pack" as const,
            tier: purchase.tier,
            size: purchase.entryCount,
          },
          price: displayEntryPackCheckoutPrice(quote),
          validFrom: purchase.validFrom.toString(),
          lastUsableDate: getEntryPackLastUsableDate(
            purchase.validUntil
          ).toString(),
          disclosure: getEntryPackPaymentDisclosure(purchase.locale),
        };
      })
    ).pipe(Effect.provide(purchaseLayer))
);

const repriceAction = defineWorkspaceAction(
  {
    operation: "passes.reprice-entry-pack-checkout",
    resolveIssuedLocale: resolveIssuedOrderLocale,
    schema: Schema.toStandardSchemaV1(repriceEntryPackCheckoutSchema),
    deadline: checkoutSubmitDeadline,
    logInput: false,
  },
  (input) =>
    purchaseFailure(
      Effect.gen(function* () {
        const referralCode = yield* readReferralCode;
        const submittedCode = Option.getOrUndefined(
          yield* normalizeSubmittedPromotionCode({
            submittedCode: input.submittedCode,
          })
        );
        const result = yield* repriceEntryPackPurchase({
          orderId: input.orderId,
          displayedPriceFingerprint: input.displayedPriceFingerprint,
          ...(submittedCode && { submittedCode }),
          ...(referralCode && { referralCode }),
        });
        return {
          status: result.status,
          price: displayEntryPackCheckoutPrice(result.quote),
        };
      }).pipe(
        Effect.catchTag("PromotionCodeUnavailableError", () =>
          Effect.succeed({ status: "code_unavailable" as const })
        )
      )
    ).pipe(Effect.provide(purchaseLayer))
);

const payAction = defineWorkspaceAction(
  {
    operation: "passes.pay-entry-pack",
    resolveIssuedLocale: resolveIssuedOrderLocale,
    schema: Schema.toStandardSchemaV1(payEntryPackCheckoutSchema),
    deadline: checkoutSubmitDeadline,
    logInput: false,
  },
  (input) =>
    purchaseFailure(
      Effect.gen(function* () {
        const result = yield* payForEntryPack(input);
        if (result.status === "pricing_changed") {
          return {
            status: result.status,
            price: displayEntryPackCheckoutPrice(result.quote),
          };
        }
        return result;
      })
    ).pipe(Effect.provide(payLayer))
);

export const beginEntryPackCheckout: typeof beginAction = async (...args) =>
  await beginAction(...args);
export const repriceEntryPackCheckout: typeof repriceAction = async (...args) =>
  await repriceAction(...args);
export const payEntryPackCheckout: typeof payAction = async (...args) =>
  await payAction(...args);
