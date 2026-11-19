import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import {
  CurrentCustomerAccount,
  requireVerifiedIdentity,
} from "@/features/account/backend/current-customer-account";
import { testSessionProfile } from "@/features/account/backend/customer-authentication.test-utils";
import {
  type CustomerAccountId,
  customerAccountIdSchema,
} from "@/features/account/customer-account";
import { LatePaymentVerificationService } from "@/features/checkout/backend/payment/late-payment-verification.service";
import { ProviderPaymentFinalizationService } from "@/features/checkout/backend/payment/provider-payment-finalization.service";
import { WorkspaceFeatureFlagService } from "@/features/feature-flags/backend/workspace-feature-flag.service";
import { type OrderId, orderIdSchema } from "@/features/order";
import {
  createWorkspacePostgresSuiteDatabase,
  type WorkspacePostgresSuiteDatabase,
} from "@/shared/testing/workspace-postgres-test-database.test-utils";
import { atInstant } from "@/shared/testing/workspace-test-clock.test-utils";
import { maskEmailAddress } from "@/shared/utils";
import { loadEntryPackStatus } from "./entry-pack-status";

describe.skipIf(!process.env.WORKSPACE_TEST_DATABASE_URL)(
  "Entry pack status",
  () => {
    const buyer = customerAccountIdSchema.make(crypto.randomUUID());
    const holder = customerAccountIdSchema.make(crypto.randomUUID());
    const holderEmail = "pack-holder@example.invalid";
    const now = Temporal.Instant.from("2026-11-19T12:00:00Z");
    const paymentPage = "https://payment.example.invalid/entry-pack";
    let database: WorkspacePostgresSuiteDatabase;

    beforeAll(async () => {
      database = (await createWorkspacePostgresSuiteDatabase(
        "entry_pack_status"
      ))!;
      await database.pool.query(
        "insert into customer_accounts (id) values ($1), ($2)",
        [buyer, holder]
      );
      await database.pool.query(
        'insert into auth."user" (id, name, email, email_verified) values ($1, $2, $3, false)',
        [holder, "", holderEmail]
      );
    });
    afterAll(async () => {
      await database?.close();
    });

    const seedOrder = async ({
      paymentState,
      holderAccountId = buyer,
    }: {
      readonly paymentState: "paid" | "pending" | "expired";
      readonly holderAccountId?: CustomerAccountId;
    }) => {
      const orderId = orderIdSchema.make(crypto.randomUUID());
      const attemptId = crypto.randomUUID();
      const paidAt = paymentState === "paid" ? now.toString() : null;
      await database.pool.query(
        `insert into orders
          (id, kind, dotypos_customer_id, payment_state, fulfillment_state, active_payment_attempt_id, paid_at)
          values ($1, 'pass-purchase', 'fixture-buyer', $2, 'not_started', $3, $4)`,
        [orderId, paymentState, attemptId, paidAt]
      );
      await database.pool.query(
        `insert into pass_purchases
          (id, buyer_account_id, holder_account_id, product, tier, entry_count, status, valid_from, valid_until, quote, locale, created_at)
          values ($1, $2, $3, 'entry-pack', 'open-space', 5, $4, '2026-11-19', '2027-01-19', '{}', 'en-US', $5)`,
        [
          orderId,
          buyer,
          holderAccountId,
          { paid: "active", pending: "pending_payment", expired: "void" }[
            paymentState
          ],
          now.toString(),
        ]
      );
      await database.pool.query(
        `insert into payment_attempts
          (id, order_id, provider, provider_order_id, security_token, state, amount_value, amount_exponent, currency,
           provider_redirect_url, failure_code, provider_order_created_at)
          values ($1, $2, 'nexi', $1, 'synthetic', $3, 100000, 2, 'CZK', $4, $5, $6)`,
        [
          attemptId,
          orderId,
          paymentState,
          paymentPage,
          paymentState === "expired" ? "fixture_expired" : null,
          now.toString(),
        ]
      );
      return { orderId, attemptId };
    };

    const view = (
      orderId: OrderId,
      {
        viewer = buyer,
        flag = true,
        finalize,
        recover,
      }: {
        readonly viewer?: CustomerAccountId | null;
        readonly flag?: boolean;
        readonly finalize?: (
          id: OrderId
        ) => Effect.Effect<"awaiting_payment" | "pending">;
        readonly recover?: (id: OrderId) => Effect.Effect<"recovery_started">;
      } = {}
    ) =>
      Effect.runPromise(
        loadEntryPackStatus(orderId).pipe(
          Effect.provide(
            Layer.mergeAll(
              database.layer,
              Layer.mock(CurrentCustomerAccount, {
                requireActive: requireVerifiedIdentity(
                  viewer === null
                    ? null
                    : {
                        accountId: viewer,
                        email: "pack-viewer@example.invalid",
                        deletionRequested: false,
                        ...testSessionProfile,
                      }
                ),
                peek: Effect.succeed({ kind: "signed-out" } as const),
              }),
              Layer.mock(WorkspaceFeatureFlagService, {
                isEnabled: () => Effect.succeed(flag),
              }),
              Layer.mock(ProviderPaymentFinalizationService, {
                finalizePendingProviderPayment: ({ orderId: id }) =>
                  finalize?.(id) ??
                  Effect.die("Unexpected payment verification"),
              }),
              Layer.mock(LatePaymentVerificationService, {
                startRecoveryIfSettled: ({ orderId: id }) =>
                  recover?.(id) ?? Effect.die("Unexpected payment recovery"),
              })
            )
          ),
          atInstant(now)
        )
      );

    test("only the active buyer can inspect or refresh a purchase", async () => {
      const { orderId } = await seedOrder({
        paymentState: "pending",
        holderAccountId: holder,
      });
      expect(await view(orderId, { flag: false })).toEqual({
        status: "not_found",
      });
      expect(await view(orderId, { viewer: holder })).toEqual({
        status: "not_found",
      });
      expect(await view(orderId, { viewer: null })).toEqual({
        status: "sign_in",
      });

      const checked: OrderId[] = [];
      expect(
        await view(orderId, {
          finalize: (id) =>
            Effect.sync(() => {
              checked.push(id);
              return "awaiting_payment" as const;
            }),
        })
      ).toMatchObject({ status: "pending", paymentPage });
      expect(checked).toEqual([orderId]);
      expect(
        await view(orderId, { finalize: () => Effect.succeed("pending") })
      ).toMatchObject({ status: "pending", paymentPage: undefined });
    });

    test("only the buyer receives the paid gift designation and masked holder", async () => {
      const { orderId } = await seedOrder({
        paymentState: "paid",
        holderAccountId: holder,
      });
      expect(await view(orderId, { viewer: holder })).toEqual({
        status: "not_found",
      });
      expect(await view(orderId)).toMatchObject({
        status: "paid",
        gift: true,
        maskedHolderEmail: maskEmailAddress(holderEmail),
      });
      const self = await seedOrder({ paymentState: "paid" });
      expect(await view(self.orderId)).toMatchObject({
        status: "paid",
        gift: false,
        maskedHolderEmail: undefined,
      });
    });

    test("reads the recorded refund after checking for a late capture", async () => {
      const { orderId, attemptId } = await seedOrder({
        paymentState: "expired",
      });
      expect(
        await view(orderId, {
          recover: (id) =>
            Effect.promise(async () => {
              expect(id).toBe(orderId);
              await database.pool.query(
                "update payment_attempts set state = 'paid', refund_state = 'required', failure_code = null where id = $1",
                [attemptId]
              );
              return "recovery_started" as const;
            }),
        })
      ).toMatchObject({ status: "refund_required" });

      await database.pool.query(
        "update payment_attempts set refund_state = 'refunded', refunded_amount_value = amount_value, refunded_at = now() where id = $1",
        [attemptId]
      );
      expect(await view(orderId)).toMatchObject({ status: "refunded" });
    });
  }
);
