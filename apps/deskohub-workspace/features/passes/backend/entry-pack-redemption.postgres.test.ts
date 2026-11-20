import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DotyposReservationIdSchema } from "@deskohub/dotypos";
import { testEmailAddress } from "@deskohub/test-email";
import { Effect, Layer, Schema } from "effect";
import { customerAccountIdSchema } from "@/features/account/customer-account";
import { makeAccountingDocumentSnapshot } from "@/features/accounting/accounting-document-snapshot";
import { testAccountingStorage } from "@/features/accounting/backend/accounting-storage.test-utils";
import { quoteCoworkEntryPack } from "@/features/checkout/backend/checkout/cowork-checkout-pricing";
import { PaymentLifecycleRepository } from "@/features/checkout/backend/repositories/payment-lifecycle.repository";
import { makeDiscountCommitment } from "@/features/discounts/commitment";
import { orderIdSchema } from "@/features/order";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import { reservationOrderId } from "@/features/reservation/persistence-contracts";
import { reservationOrderIssuanceSchema } from "@/features/reservation/reservation-order";
import { workspaceFixtures } from "@/shared/testing/workspace-fixtures.test-utils";
import {
  createWorkspacePostgresSuiteDatabase,
  type WorkspacePostgresSuiteDatabase,
} from "@/shared/testing/workspace-postgres-test-database.test-utils";
import { plainDateStringSchema } from "@/shared/utils/temporal";

describe.skipIf(!process.env.WORKSPACE_TEST_DATABASE_URL)(
  "Entry pack claims on disposable PostgreSQL",
  () => {
    let database: WorkspacePostgresSuiteDatabase;
    const buyer = customerAccountIdSchema.make(crypto.randomUUID());
    const holder = customerAccountIdSchema.make(crypto.randomUUID());
    const date = Schema.decodeUnknownSync(plainDateStringSchema);
    const decodeReservation = Schema.decodeUnknownSync(
      reservationOrderIssuanceSchema("CZ")
    );
    const now = () => Temporal.Now.instant();

    beforeAll(async () => {
      database = (await createWorkspacePostgresSuiteDatabase(
        "entry_pack_claims"
      ))!;
      await database.pool.query(
        "insert into customer_accounts (id) values ($1), ($2)",
        [buyer, holder]
      );
    });
    afterAll(async () => {
      await database?.close();
    });

    const seedPack = async () => {
      const passId = orderIdSchema.make(crypto.randomUUID());
      await database.pool.query(
        `insert into orders
          (id, kind, dotypos_customer_id, payment_state, fulfillment_state, paid_at)
          values ($1, 'pass-purchase', 'fixture-buyer', 'paid', 'fulfilled', now())`,
        [passId]
      );
      await database.pool.query(
        `insert into pass_purchases
          (id, buyer_account_id, holder_account_id, product, tier, entry_count, status, valid_from, valid_until, quote, locale, created_at)
          values ($1, $2, $3, 'entry-pack', 'open-space', 5, 'active', '2099-06-01', '2099-07-01', '{}', 'en-US', now())`,
        [passId, buyer, holder]
      );
      return passId;
    };

    const selection = (serviceDate: string, coffee = false) =>
      decodeReservation({
        kind: "cowork",
        entryTier: "open-space",
        date: serviceDate,
        coffee,
        name: "Synthetic Customer",
        email: testEmailAddress("entry-pack-claim"),
        phone: "+420 700 000 000",
        billing: { purpose: "personal", invoice: "none" },
      });

    const draft = (serviceDate: string, author = holder) =>
      Effect.runPromise(
        workspaceFixtures(database.db).reservation({
          stage: { reservation: "draft" },
          author,
          details: {
            kind: "cowork",
            entryTier: "open-space",
            date: date(serviceDate),
            coffee: false,
          },
        })
      );
    const runReservations = (f) =>
      Effect.runPromise(
        WorkspaceReservationRepository.pipe(
          Effect.flatMap(f),
          Effect.provide(WorkspaceReservationRepository.Default),
          Effect.provide(database.layer)
        )
      );
    const claim = (
      reservation,
      passId,
      serviceDate,
      holderAccountId = holder
    ) =>
      runReservations((repository) =>
        repository.claimHoldCreation(reservation.id, {
          passId,
          holderAccountId,
          date: date(serviceDate),
          tier: "open-space",
        })
      );
    const status = (reservation) =>
      runReservations((repository) =>
        repository.findEntryPackClaim(reservation.id)
      ).then((entry) => entry?.status);

    test("rejects a buyer who is not the holder and the exclusive end date", async () => {
      const passId = await seedPack();
      const buyerDraft = await draft("2099-06-01", buyer);
      const endDateDraft = await draft("2099-07-01");
      await expect(
        claim(buyerDraft, passId, "2099-06-01", buyer)
      ).rejects.toMatchObject({
        _tag: "EntryPackUnavailableError",
      });
      await expect(
        claim(endDateDraft, passId, "2099-07-01")
      ).rejects.toMatchObject({
        _tag: "EntryPackUnavailableError",
      });
      expect(await status(buyerDraft)).toBeUndefined();
      expect(await status(endDateDraft)).toBeUndefined();
    });

    test("serializes the same Prague date across two packs", async () => {
      const serviceDate = "2099-06-03";
      const [first, second] = await Promise.all([
        draft(serviceDate),
        draft(serviceDate),
      ]);
      const [firstPack, secondPack] = await Promise.all([
        seedPack(),
        seedPack(),
      ]);
      const results = await Promise.allSettled([
        claim(first, firstPack, serviceDate),
        claim(second, secondPack, serviceDate),
      ]);
      expect(results.filter(({ status }) => status === "fulfilled")).toEqual([
        { status: "fulfilled", value: true },
      ]);
      const reserved = results[0].status === "fulfilled" ? first : second;
      const rejected = reserved === first ? second : first;
      expect(await status(reserved)).toBe("reserved");
      expect(await status(rejected)).toBeUndefined();
      expect(
        await runReservations((repository) => repository.findById(rejected.id))
      ).toMatchObject({ reservationState: "cancelled" });
    });

    test("admits one last entry and makes a provider hold failure reusable", async () => {
      const passId = await seedPack();
      for (const day of [10, 11, 12, 13]) {
        const serviceDate = `2099-06-${day}`;
        expect(await claim(await draft(serviceDate), passId, serviceDate)).toBe(
          true
        );
      }
      const first = await draft("2099-06-14");
      const second = await draft("2099-06-15");
      const results = await Promise.allSettled([
        claim(first, passId, "2099-06-14"),
        claim(second, passId, "2099-06-15"),
      ]);
      expect(
        results.filter(({ status }) => status === "fulfilled")
      ).toHaveLength(1);
      const held = results[0].status === "fulfilled" ? first : second;
      await runReservations((repository) =>
        repository.releaseHoldCreation(held.id)
      );
      expect(await status(held)).toBe("released");
      const replacement = await draft("2099-06-16");
      expect(await claim(replacement, passId, "2099-06-16")).toBe(true);
    });

    const exercisePayment = async ({ serviceDate, coffee, outcome }) => {
      const passId = await seedPack();
      const reservation = await draft(serviceDate);
      await claim(reservation, passId, serviceDate);
      const dotyposReservationId = DotyposReservationIdSchema.make(
        crypto.randomUUID()
      );
      await runReservations((repository) =>
        repository.attachHold({
          id: reservation.id,
          dotyposReservationId,
          reservationCreatedAt: now(),
          reservationHoldExpiresAt: now().add({ minutes: 30 }),
        })
      );

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const lifecycle = yield* PaymentLifecycleRepository;
          const prepared = yield* quoteCoworkEntryPack({
            reservation: selection(serviceDate, coffee),
            entryPack: { passId, tier: "open-space" },
          });
          const orderId = reservationOrderId(reservation.id);
          const payment = {
            orderId,
            amount: prepared.quote.payment.expectedPrice,
            commitment: makeDiscountCommitment({
              firstServiceDate: date(serviceDate),
              product: { kind: "cowork", tier: "open-space" },
              applications: [],
            }),
            locale: "en-US" as const,
            accountingSnapshot: makeAccountingDocumentSnapshot({
              workspaceReservationId: reservation.id,
              dotyposReservationId,
              dotyposCustomerId: reservation.dotyposCustomerId,
              locale: "en-US",
              prepared,
            }),
          };
          if (!coffee)
            return (yield* lifecycle.completeInternalPayment(payment)).attempt;
          const attempt = yield* lifecycle.createPendingProviderAttempt({
            ...payment,
            provider: "nexi",
            providerOrderId: `synthetic-${crypto.randomUUID()}`,
          });
          expect(yield* Effect.promise(() => status(reservation))).toBe(
            "reserved"
          );
          yield* lifecycle.attachProviderSession({
            id: attempt.id,
            securityToken: "synthetic",
            providerRedirectUrl: "https://payment.example.invalid/",
          });
          if (outcome === "failed") {
            return (yield* lifecycle.markTerminal({
              id: attempt.id,
              orderId,
              state: "failed",
              failureCode: "nexi_payment_failed",
            })).attempt;
          }
          return (yield* lifecycle.markPaid({
            id: attempt.id,
            orderId,
            paidAt: now(),
          })).attempt;
        }).pipe(
          Effect.provide(
            PaymentLifecycleRepository.Default.pipe(
              Layer.provide(
                Layer.merge(
                  database.layer,
                  testAccountingStorage(database.layer)
                )
              )
            )
          )
        )
      );
      return { reservation, result };
    };

    test("spends the entry in the internal zero-total payment", async () => {
      const { reservation, result } = await exercisePayment({
        serviceDate: "2099-06-20",
        coffee: false,
        outcome: "paid",
      });
      expect(result).toMatchObject({ provider: "internal", state: "paid" });
      expect(await status(reservation)).toBe("consumed");
    });

    test("keeps an entry held until paid and only charges the coffee through Nexi", async () => {
      const { reservation, result } = await exercisePayment({
        serviceDate: "2099-06-21",
        coffee: true,
        outcome: "paid",
      });
      expect(result).toMatchObject({
        provider: "nexi",
        state: "paid",
        amount: { value: 5_000 },
      });
      expect(await status(reservation)).toBe("consumed");
    });

    test("releases an entry once Nexi confirms a failed attempt", async () => {
      const { reservation, result } = await exercisePayment({
        serviceDate: "2099-06-22",
        coffee: true,
        outcome: "failed",
      });
      expect(result).toMatchObject({ provider: "nexi", state: "failed" });
      expect(await status(reservation)).toBe("released");
    });
  }
);
