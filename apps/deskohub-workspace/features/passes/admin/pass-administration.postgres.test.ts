import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DotyposService, DotyposTableSchema } from "@deskohub/dotypos";
import { makeInMemoryDotypos } from "@deskohub/dotypos/testing";
import { testEmailAddress } from "@deskohub/test-email";
import { Effect, Layer, Result, Schema } from "effect";
import { WorkspaceDatabaseAdvisoryLock } from "@/db/postgres-advisory-lock";
import { customerAccountIdSchema } from "@/features/account/customer-account";
import { ReservationAdministrationService } from "@/features/administration/reservation-administration.service";
import { CurrentAdministrator } from "@/features/administrators/backend/current-administrator";
import { orderIdSchema } from "@/features/order";
import { GoogleCalendarWorkspaceLimitationsService } from "@/features/reservation/backend/google-calendar-workspace-limitations.service";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import { getWorkspaceDate } from "@/features/reservation/reservation-date";
import { workspaceFixtures } from "@/shared/testing/workspace-fixtures.test-utils";
import {
  createWorkspacePostgresSuiteDatabase,
  type WorkspacePostgresSuiteDatabase,
} from "@/shared/testing/workspace-postgres-test-database.test-utils";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import { applyPackAdjustment } from "./apply-pass-adjustment";
import { beginUnlimitedPassChange } from "./begin-unlimited-pass-change";
import { completePassChange } from "./complete-pass-change";
import { grantPass } from "./grant-pass";

describe.skipIf(!process.env.WORKSPACE_TEST_DATABASE_URL)(
  "pass administration on disposable PostgreSQL",
  () => {
    let database: WorkspacePostgresSuiteDatabase;
    const actor = {
      accountId: customerAccountIdSchema.make(crypto.randomUUID()),
      email: testEmailAddress("pass-operator"),
    };
    const holder = customerAccountIdSchema.make(crypto.randomUUID());
    const recipient = customerAccountIdSchema.make(crypto.randomUUID());
    const date = plainDateStringSchema.make;

    beforeAll(async () => {
      database = (await createWorkspacePostgresSuiteDatabase(
        "pass_administration"
      ))!;
      await database.pool.query(
        "insert into customer_accounts (id, dotypos_customer_id) values ($1, '4141'), ($2, '4142'), ($3, '4143')",
        [actor.accountId, holder, recipient]
      );
      await database.pool.query(
        `insert into auth."user" (id, email, name, email_verified, created_at, updated_at)
      values ($1, $2, 'Fixture Holder', true, now(), now()), ($3, $4, 'Fixture Recipient', true, now(), now())`,
        [
          holder,
          testEmailAddress("pass-holder"),
          recipient,
          testEmailAddress("pass-recipient"),
        ]
      );
    });

    afterAll(async () => database?.close());

    const run = (effect, provider = makeInMemoryDotypos({})) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provide(
            Layer.mergeAll(
              database.layer,
              WorkspaceDatabaseAdvisoryLock.makeLayer(database.databasePool),
              Layer.succeed(CurrentAdministrator, actor),
              provider.layer,
              WorkspaceReservationRepository.Default.pipe(
                Layer.provide(database.layer)
              ),
              Layer.mock(GoogleCalendarWorkspaceLimitationsService, {
                listLimitations: () => Effect.succeed([]),
              }),
              Layer.mock(ReservationAdministrationService, {})
            )
          )
        )
      );

    const seedPack = async () => {
      const passId = orderIdSchema.make(crypto.randomUUID());
      const attemptId = crypto.randomUUID();
      await database.pool.query(
        `insert into orders (id, kind, dotypos_customer_id, payment_state, fulfillment_state, paid_at, fulfilled_at, active_payment_attempt_id)
      values ($1,'pass-purchase','4142','paid','fulfilled',now(),now(),$2)`,
        [passId, attemptId]
      );
      await database.pool.query(
        `insert into payment_attempts (id, order_id, provider, state, provider_order_id, amount_value, amount_exponent, currency)
      values ($1,$2,'nexi','paid',$1,100000,2,'CZK')`,
        [attemptId, passId]
      );
      // The deployed writer's column list omits the new holder revision.
      await database.pool.query(
        `insert into pass_purchases
      (id,buyer_account_id,holder_account_id,product,tier,entry_count,status,valid_from,valid_until,quote,locale,created_at)
      values ($1,$2,$2,'entry-pack','open-space',5,'active','2099-06-01','2099-08-01','{}','en-US',now())`,
        [passId, holder]
      );
      return { passId, attemptId };
    };

    test("concurrent stale validity changes reserve one refund and a replay creates no new obligation", async () => {
      const { passId, attemptId } = await seedPack();
      const change = {
        _tag: "validity" as const,
        expectedValidUntil: date("2099-08-01"),
        lastDay: date("2099-07-23"),
        refundValue: 20_000,
      };
      const first = {
        passId,
        requestId: crypto.randomUUID(),
        reason: "Fixture prorated reduction",
        change,
      };
      const second = { ...first, requestId: crypto.randomUUID() };
      const results = await Promise.all(
        [first, second].map((input) =>
          run(Effect.result(applyPackAdjustment(input)))
        )
      );
      expect(results.filter(Result.isSuccess)).toHaveLength(1);
      expect(
        results.filter(Result.isFailure).map(({ failure }) => failure.reason)
      ).toEqual(["changed"]);
      const winner = results[0]._tag === "Success" ? first : second;
      expect((await run(applyPackAdjustment(winner))).requestId).toBe(
        winner.requestId
      );
      const { rows } = await database.pool.query(
        `select pass.valid_until::text, pass.holder_version,
      attempt.refund_state, attempt.refund_target_value, attempt.refunded_amount_value
      from pass_purchases pass join payment_attempts attempt on attempt.order_id = pass.id where attempt.id=$1`,
        [attemptId]
      );
      expect(rows).toEqual([
        {
          valid_until: "2099-07-24",
          holder_version: 0,
          refund_state: "required",
          refund_target_value: 20_000,
          refunded_amount_value: null,
        },
      ]);
    });

    test("rejects a refund above the amount still available after provider refunds", async () => {
      const { passId, attemptId } = await seedPack();
      await database.pool.query(
        `update payment_attempts set refund_state='refunded', refunded_amount_value=73000, refunded_at=now() where id=$1`,
        [attemptId]
      );
      const outcome = await run(
        Effect.result(
          applyPackAdjustment({
            passId,
            requestId: crypto.randomUUID(),
            reason: "Fixture cancellation",
            change: {
              _tag: "cancel",
              expectedValidUntil: date("2099-08-01"),
              refundValue: 28_000,
              sendCancellationEmail: false,
            },
          })
        )
      );
      expect(outcome).toMatchObject({
        _tag: "Failure",
        failure: { reason: "refund-limit" },
      });
      const { rows } = await database.pool.query(
        "select status from pass_purchases where id=$1",
        [passId]
      );
      expect(rows[0]?.status).toBe("active");
    });

    test("outstanding claims block reassignment and validity cannot cut off their booked dates", async () => {
      const { passId } = await seedPack();
      const reservation = await Effect.runPromise(
        workspaceFixtures(database.db).reservation({
          stage: { reservation: "draft" },
          author: holder,
        })
      );
      await database.pool.query(
        "insert into pass_entry_claims (reservation_id, pass_id, date, status) values ($1,$2,'2099-07-30','reserved')",
        [reservation.id, passId]
      );
      const request = {
        passId,
        requestId: crypto.randomUUID(),
        reason: "Fixture claim boundary",
      };
      const reassign = await run(
        Effect.result(
          applyPackAdjustment({
            ...request,
            change: {
              _tag: "reassign",
              expectedHolderAccountId: holder,
              holderAccountId: recipient,
            },
          })
        )
      );
      expect(reassign).toMatchObject({
        _tag: "Failure",
        failure: { reason: "first-use" },
      });
      const shortened = await run(
        Effect.result(
          applyPackAdjustment({
            ...request,
            change: {
              _tag: "validity",
              expectedValidUntil: date("2099-08-01"),
              lastDay: date("2099-07-29"),
              refundValue: 0,
            },
          })
        )
      );
      expect(shortened).toMatchObject({
        _tag: "Failure",
        failure: { reason: "invalid-validity" },
      });
      const kept = await run(
        applyPackAdjustment({
          ...request,
          change: {
            _tag: "validity",
            expectedValidUntil: date("2099-08-01"),
            lastDay: date("2099-07-30"),
            refundValue: 0,
          },
        })
      );
      expect(kept.completedAt).not.toBeNull();
    });

    test("reassignment rotates invitation identity and holder capability versions", async () => {
      const { passId } = await seedPack();
      const reassign = (previous, next) =>
        run(
          applyPackAdjustment({
            passId,
            requestId: crypto.randomUUID(),
            reason: "Fixture holder transfer",
            change: {
              _tag: "reassign",
              expectedHolderAccountId: previous,
              holderAccountId: next,
            },
          })
        );
      await reassign(holder, recipient);
      const first = (
        await database.pool.query(
          "select context_id, generation, first_generation from entry_pack_gift_invitations where order_id=$1",
          [passId]
        )
      ).rows[0];
      expect(first.generation).toBe(first.first_generation);
      await reassign(recipient, holder);
      await reassign(holder, recipient);
      const current = (
        await database.pool.query(
          `select invitation.context_id, invitation.generation,
      invitation.first_generation, pass.holder_version, pass.gift_claimed_at from entry_pack_gift_invitations invitation
      join pass_purchases pass on pass.id=invitation.order_id where pass.id=$1`,
          [passId]
        )
      ).rows[0];
      expect(current.context_id).not.toBe(first.context_id);
      expect(current.generation).toBeGreaterThan(first.generation);
      expect(current.first_generation).toBe(current.generation);
      expect(current.holder_version).toBe(3);
      expect(current.gift_claimed_at).toBeNull();
    });

    test("a complimentary grant creates one order, issues the claim and creates no payment or consent", async () => {
      const passId = orderIdSchema.make(crypto.randomUUID());
      const request = {
        requestId: passId,
        passId,
        reason: "Fixture community grant",
        change: {
          _tag: "grant" as const,
          holderAccountId: recipient,
          selection: {
            kind: "entry-pack" as const,
            tier: "open-space" as const,
            size: 5 as const,
          },
        },
      };
      const prior = await run(grantPass(request, "en-US"));
      const replay = await run(grantPass(request, "en-US"));
      expect(prior.requestId).toBe(replay.requestId);
      const { rows } = await database.pool.query(
        `select orders.payment_state, orders.paid_at, orders.active_payment_attempt_id,
      (select count(*)::int from payment_attempts where order_id=orders.id) as attempts,
      (select count(*)::int from legal_evidence_events where order_id=orders.id) as documents,
      (select count(*)::int from entry_pack_gift_invitations where order_id=orders.id) as invitations
      from orders where id=$1`,
        [passId]
      );
      expect(rows).toEqual([
        {
          payment_state: "complimentary",
          paid_at: null,
          active_payment_attempt_id: null,
          attempts: 0,
          documents: 0,
          invitations: 1,
        },
      ]);
    });

    test("Unlimited grant, shortening and re-extension settle marked days without duplicating provider holds", async () => {
      const table = Schema.decodeUnknownSync(DotyposTableSchema)({
        id: "4144",
        _cloudId: "1",
        display: true,
        enabled: true,
        name: "Synthetic reserved desk",
        seats: "1",
        tags: ["cowork:reserved-desk"],
      });
      const provider = makeInMemoryDotypos({ tables: [table] });
      const passId = orderIdSchema.make(crypto.randomUUID());
      const start = getWorkspaceDate(Temporal.Now.instant()).add({ days: 2 });
      const originalEnd = date(start.add({ days: 30 }).toString());
      const shortenedEnd = date(start.add({ days: 28 }).toString());
      const request = {
        passId,
        requestId: passId,
        reason: "Fixture monthly grant",
        change: {
          _tag: "grant" as const,
          holderAccountId: holder,
          selection: {
            tier: "reserved-desk" as const,
            startDate: date(start.toString()),
          },
        },
      };
      const grant = await run(grantPass(request, "en-US"), provider);
      expect(grant.completedAt).toBeNull();
      expect(
        (await run(completePassChange(grant), provider)).completedAt
      ).not.toBeNull();
      const passDays = async () =>
        (
          await database.pool.query(
            `select service_date::text, reservation_state, dotypos_reservation_id from workspace_reservations
      where pass_id=$1 order by service_date`,
            [passId]
          )
        ).rows;
      const original = await passDays();
      expect(original).toHaveLength(30);
      expect(
        original.every((row) => row.reservation_state === "confirmed")
      ).toBe(true);

      const adjust = (expectedValidUntil, lastDay) =>
        run(
          beginUnlimitedPassChange({
            passId,
            requestId: crypto.randomUUID(),
            reason: "Fixture validity change",
            change: {
              _tag: "validity",
              expectedValidUntil,
              lastDay: date(lastDay.toString()),
              refundValue: 0,
            },
          }),
          provider
        );
      const shortening = await adjust(originalEnd, start.add({ days: 27 }));
      expect(
        (await run(completePassChange(shortening), provider)).completedAt
      ).not.toBeNull();
      expect(
        (await passDays()).slice(-2).map((row) => row.reservation_state)
      ).toEqual(["cancelled", "cancelled"]);

      const extension = await adjust(shortenedEnd, start.add({ days: 29 }));
      expect(
        (await run(completePassChange(extension), provider)).completedAt
      ).not.toBeNull();
      await run(completePassChange(extension), provider);
      const restored = await passDays();
      expect(restored.slice(0, 28)).toEqual(original.slice(0, 28));
      expect(restored.slice(-2).map((row) => row.reservation_state)).toEqual([
        "confirmed",
        "confirmed",
      ]);
      expect(
        restored.slice(-2).map((row) => row.dotypos_reservation_id)
      ).not.toEqual(
        original.slice(-2).map((row) => row.dotypos_reservation_id)
      );
      const observed = await run(
        DotyposService.pipe(
          Effect.flatMap((dotypos) => dotypos.listReservations({}))
        ),
        provider
      );
      expect(
        observed.filter(({ status }) => status === "CONFIRMED")
      ).toHaveLength(30);
      expect(
        observed.filter(({ status }) => status === "CANCELLED")
      ).toHaveLength(2);

      const transfer = await run(
        beginUnlimitedPassChange({
          passId,
          requestId: crypto.randomUUID(),
          reason: "Fixture holder transfer",
          change: {
            _tag: "reassign",
            expectedHolderAccountId: holder,
            holderAccountId: recipient,
            holderCustomerId: "4143",
          },
        }),
        provider
      );
      expect(transfer.completedAt).toBeNull();
      expect(
        (await run(completePassChange(transfer), provider)).completedAt
      ).not.toBeNull();
      await run(completePassChange(transfer), provider);
      const transferred = await run(
        DotyposService.pipe(
          Effect.flatMap((dotypos) =>
            dotypos.listReservations({ customerId: "4143" })
          )
        ),
        provider
      );
      expect(transferred.map(({ id, status }) => [id, status]).sort()).toEqual(
        restored
          .map(({ dotypos_reservation_id }) => [
            dotypos_reservation_id,
            "CONFIRMED",
          ])
          .sort()
      );
      const { rows } = await database.pool.query(
        "select holder_account_id, holder_version, gift_claimed_at from pass_purchases where id=$1",
        [passId]
      );
      expect(rows[0]).toEqual({
        holder_account_id: recipient,
        holder_version: 1,
        gift_claimed_at: null,
      });
    });
  }
);
