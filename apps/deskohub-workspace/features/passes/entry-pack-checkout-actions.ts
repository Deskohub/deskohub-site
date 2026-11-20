"use server";

import { Duration, Effect, Layer, Option, Schema, Struct } from "effect";
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
import { workspaceProductMonitorOptions } from "@/features/checkout/product-catalog";
import { canonicalPromotionCodeSchema } from "@/features/discounts/contracts";
import { DiscountService } from "@/features/discounts/discount.service";
import { normalizeSubmittedPromotionCode } from "@/features/discounts/promotion-code";
import { WorkspaceFeatureFlagService } from "@/features/feature-flags/backend/workspace-feature-flag.service";
import { locales } from "@/features/i18n";
import { orderIdSchema } from "@/features/order";
import { ReferralService } from "@/features/referrals";
import { ReferralReleaseGateRequest } from "@/features/referrals/referral-release-gate.server";
import { RememberedReferral } from "@/features/referrals/remembered-referral.service";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import { reservationCustomerNameSchema } from "@/features/reservation/reservation-contact";
import { getCurrentWorkspaceDate } from "@/features/reservation/reservation-date";
import { WorkspaceDotyposLayer } from "@/shared/backend/config/dotypos.config";
import { defineWorkspaceAction } from "@/shared/backend/workspace-action";
import { runWorkspaceEffectOrElse } from "@/shared/backend/workspace-effect";
import type { ResolveIssuedActionLocale } from "@/shared/utils/action-middleware/locale";
import { currentInstant, plainDateStringSchema } from "@/shared/utils/temporal";
import { readOwnedPassPurchaseOrderLocale } from "./backend/entry-pack-order";
import {
  beginEntryPackPurchase,
  displayPassPurchasePrice,
  EntryPackPurchaseError,
  getEntryPackPaymentDisclosure,
  payForEntryPack,
  repriceEntryPackPurchase,
} from "./backend/entry-pack-purchase";
import {
  getBookableUnlimitedStarts,
  unlimitedStartRangeMaxDays,
} from "./backend/unlimited-pass-capacity";
import {
  beginUnlimitedPassPurchase,
  getUnlimitedPassPaymentDisclosure,
} from "./backend/unlimited-pass-purchase";
import {
  beginEntryPackCheckoutSchema,
  payEntryPackCheckoutSchema,
  repriceEntryPackCheckoutSchema,
} from "./entry-pack-checkout";
import { getEntryPackLastUsableDate } from "./pass-offer";
import { passPurchaseQuoteCodec } from "./pass-purchase-quote";
import {
  unlimitedPassRequiresEarlyStart,
  unlimitedPassSelectionSchema,
} from "./unlimited-pass";

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
  PaymentProvidersLive,
  WorkspaceDotyposLayer
);

const readActionOrder = Schema.decodeUnknownOption(
  Schema.Struct({ orderId: orderIdSchema })
);

const resolveIssuedLocale =
  (product: "entry-pack" | "unlimited"): ResolveIssuedActionLocale =>
  async (clientInput) => {
    const order = readActionOrder(clientInput);
    if (Option.isNone(order)) return undefined;

    return readOwnedPassPurchaseOrderLocale(order.value.orderId, product).pipe(
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

const purchaseFailure = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  product: "entry-pack" | "unlimited" = "entry-pack"
) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is E & EntryPackPurchaseError =>
        error instanceof EntryPackPurchaseError,
      ({ reason, locale, earlyStartRequired }) =>
        Effect.succeed(
          reason === "terms-changed" && locale
            ? {
                status: "terms_changed" as const,
                disclosure:
                  product === "entry-pack"
                    ? getEntryPackPaymentDisclosure(locale)
                    : getUnlimitedPassPaymentDisclosure(
                        locale,
                        earlyStartRequired ?? false
                      ),
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
        const quote = yield* Schema.decodeEffect(passPurchaseQuoteCodec)(
          purchase.quote
        );
        return {
          status: "ready" as const,
          product: {
            kind: "entry-pack" as const,
            tier: purchase.tier,
            size: purchase.entryCount,
          },
          price: displayPassPurchasePrice(quote),
          validFrom: purchase.validFrom.toString(),
          lastUsableDate: getEntryPackLastUsableDate(
            purchase.validUntil
          ).toString(),
          disclosure: getEntryPackPaymentDisclosure(purchase.locale),
        };
      })
    ).pipe(Effect.provide(purchaseLayer))
);

const makeRepriceAction = (productKind: "entry-pack" | "unlimited") =>
  defineWorkspaceAction(
    {
      operation: `passes.reprice-${productKind}-checkout`,
      resolveIssuedLocale: resolveIssuedLocale(productKind),
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
            productKind,
            displayedPriceFingerprint: input.displayedPriceFingerprint,
            ...(submittedCode && { submittedCode }),
            ...(referralCode && { referralCode }),
          });
          return {
            status: result.status,
            price: displayPassPurchasePrice(result.quote),
          };
        }).pipe(
          Effect.catchTag("PromotionCodeUnavailableError", () =>
            Effect.succeed({ status: "code_unavailable" as const })
          )
        ),
        productKind
      ).pipe(Effect.provide(purchaseLayer))
  );

const makePayAction = (productKind: "entry-pack" | "unlimited") =>
  defineWorkspaceAction(
    {
      operation: `passes.pay-${productKind}`,
      resolveIssuedLocale: resolveIssuedLocale(productKind),
      schema: Schema.toStandardSchemaV1(
        Schema.Struct({
          ...payEntryPackCheckoutSchema.fields,
          unlimitedEarlyStartAccepted: Schema.optionalKey(Schema.Boolean),
        })
      ),
      deadline: checkoutSubmitDeadline,
      logInput: false,
    },
    (input) =>
      purchaseFailure(
        Effect.gen(function* () {
          const result = yield* payForEntryPack({ ...input, productKind });
          if (result.status === "pricing_changed") {
            return {
              status: result.status,
              price: displayPassPurchasePrice(result.quote),
            };
          }
          return result;
        }),
        productKind
      ).pipe(Effect.provide(payLayer))
  );

const repriceAction = makeRepriceAction("entry-pack");
const payAction = makePayAction("entry-pack");
const repriceUnlimitedAction = makeRepriceAction("unlimited");
const payUnlimitedAction = makePayAction("unlimited");

const unlimitedPurchaseLayer = Layer.mergeAll(
  purchaseLayer,
  WorkspaceDotyposLayer,
  WorkspaceReservationRepository.Default.pipe(
    Layer.provide(WorkspaceDatabase.Default)
  )
);

const beginUnlimitedAction = defineWorkspaceAction(
  {
    operation: "passes.begin-unlimited-checkout",
    schema: (locale) =>
      Schema.toStandardSchemaV1(
        Schema.Struct({
          ...Struct.omit(beginEntryPackCheckoutSchema(locale).fields, [
            "product",
          ]),
          selection: unlimitedPassSelectionSchema,
          recipientName: Schema.optionalKey(reservationCustomerNameSchema),
          supersedeOrderId: Schema.optionalKey(orderIdSchema),
        })
      ),
    deadline: Duration.seconds(180),
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
        const purchase = yield* beginUnlimitedPassPurchase({
          ...input,
          ...(referralCode && { referralCode }),
        });
        const quote = yield* Schema.decodeEffect(passPurchaseQuoteCodec)(
          purchase.quote
        );
        return {
          status: "ready" as const,
          selection: input.selection,
          price: displayPassPurchasePrice(quote),
          validFrom: purchase.validFrom,
          lastUsableDate: getEntryPackLastUsableDate(
            purchase.validUntil
          ).toString(),
          disclosure: getUnlimitedPassPaymentDisclosure(
            purchase.locale,
            unlimitedPassRequiresEarlyStart(
              purchase.validFrom,
              getCurrentWorkspaceDate(yield* currentInstant)
            )
          ),
        };
      }).pipe(
        Effect.catchTag(
          "UnlimitedPassCapacityUnavailable",
          ({ blockingDates }) =>
            Effect.succeed({
              status: "capacity_unavailable" as const,
              blockingDates: blockingDates.map((date) =>
                plainDateStringSchema.make(date.toString())
              ),
            })
        ),
        Effect.catchTag("UnlimitedPassAdmissionError", ({ reason }) =>
          Effect.succeed({
            status: "purchase_error" as const,
            reason,
          })
        )
      ),
      "unlimited"
    ).pipe(Effect.provide(unlimitedPurchaseLayer))
);

const unlimitedAvailabilityAction = defineWorkspaceAction(
  {
    operation: "passes.unlimited-start-dates",
    schema: Schema.toStandardSchemaV1(
      Schema.Struct({
        locale: Schema.Literals(locales),
        startsOn: Schema.optionalKey(plainDateStringSchema),
      })
    ),
    deadline: Duration.seconds(18),
    logInput: false,
  },
  Effect.fnUntraced(function* (input: {
    readonly startsOn?: typeof plainDateStringSchema.Type;
  }) {
    const flags = yield* WorkspaceFeatureFlagService;
    if (!(yield* flags.isEnabled("cowork_passes")))
      return { status: "unavailable" as const };
    const today = getCurrentWorkspaceDate(yield* currentInstant);
    const lastStartDate = today.add({ months: 6 });
    const requested = input.startsOn && Temporal.PlainDate.from(input.startsOn);
    const startsOn =
      requested && Temporal.PlainDate.compare(requested, today) > 0
        ? requested
        : today;
    if (Temporal.PlainDate.compare(startsOn, lastStartDate) > 0) {
      return { status: "unavailable" as const };
    }
    const rangeEnd = startsOn.add({ days: unlimitedStartRangeMaxDays });
    const endsBefore =
      Temporal.PlainDate.compare(rangeEnd, lastStartDate) > 0
        ? lastStartDate.add({ days: 1 })
        : rangeEnd;
    const read = (
      selection: Parameters<typeof getBookableUnlimitedStarts>[0]["selection"]
    ) =>
      getBookableUnlimitedStarts({ selection, startsOn, endsBefore }).pipe(
        Effect.map((dates) =>
          dates.map((date) => plainDateStringSchema.make(date.toString()))
        )
      );
    const [open, reserved, workstation] = yield* Effect.all([
      read({ tier: "open-space" }),
      read({ tier: "reserved-desk" }),
      Effect.all({
        "2x27-qhd": read({
          tier: "reserved-desk-workstation",
          monitorOption: workspaceProductMonitorOptions[0],
        }),
        "2x32-qhd": read({
          tier: "reserved-desk-workstation",
          monitorOption: workspaceProductMonitorOptions[1],
        }),
        "2x27-4k": read({
          tier: "reserved-desk-workstation",
          monitorOption: workspaceProductMonitorOptions[2],
        }),
        "2x32-4k": read({
          tier: "reserved-desk-workstation",
          monitorOption: workspaceProductMonitorOptions[3],
        }),
      }),
    ]);
    return {
      status: "ready" as const,
      today: plainDateStringSchema.make(today.toString()),
      lastStartDate: plainDateStringSchema.make(
        endsBefore.subtract({ days: 1 }).toString()
      ),
      starts: {
        "open-space": open,
        "reserved-desk": reserved,
        "reserved-desk-workstation": workstation,
      },
    };
  }, Effect.provide(unlimitedPurchaseLayer))
);

export const beginEntryPackCheckout: typeof beginAction = async (...args) =>
  await beginAction(...args);
export const repriceEntryPackCheckout: typeof repriceAction = async (...args) =>
  await repriceAction(...args);
export const payEntryPackCheckout: typeof payAction = async (...args) =>
  await payAction(...args);
export const beginUnlimitedCheckout: typeof beginUnlimitedAction = async (
  ...args
) => await beginUnlimitedAction(...args);
export const repriceUnlimitedCheckout: typeof repriceUnlimitedAction = async (
  ...args
) => await repriceUnlimitedAction(...args);
export const payUnlimitedCheckout: typeof payUnlimitedAction = async (
  ...args
) => await payUnlimitedAction(...args);
export const getUnlimitedCheckoutAvailability: typeof unlimitedAvailabilityAction =
  async (...args) => await unlimitedAvailabilityAction(...args);
