import "@/shared/testing/workspace-test-env";

import { afterAll, describe, expect, test } from "bun:test";
import type { DotyposCustomerId } from "@deskohub/dotypos";
import { testEmailAddress } from "@deskohub/test-email";
import { Effect, Layer } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { orderIdSchema } from "@/features/order";
import { CoworkPassesReleaseGate } from "@/features/passes/backend/cowork-passes-release-gate";
import { PassReminderReads } from "@/features/passes/backend/pass-reminder-reads.service";
import { getPassReminderDueAt } from "@/features/passes/pass-reminder-schedule";
import { AdvisoryAvailabilityInventory } from "@/features/reservation/backend/availability-inventory";
import { createWorkspacePostgresSuiteDatabase } from "@/shared/testing/workspace-postgres-test-database.test-utils";
import { currentInstant, plainDateStringSchema } from "@/shared/utils/temporal";
import { automationVersionIdSchema } from "../automation-identifiers";
import {
  automationScenarioLayer,
  makeEngineDotypos,
  makeEngineFixtures,
  planAndProcess,
  runEngineAt,
} from "./automation-engine-scenario.test-utils";
import {
  automationFlowFixture,
  automationLifecycleTestKit,
} from "./automation-lifecycle.test-utils";
import { planAutomationUnits } from "./automation-unit-planning";
import { makeAutomationUnitQueueFake } from "./automation-unit-queue.test-utils";
import { plannedPassReminderPage } from "./pass-reminder-intake";
import { PassReminderWritesOpen } from "./pass-reminder-write-policy";

const database = await createWorkspacePostgresSuiteDatabase(
  "pass_reminder_intake"
);
afterAll(() => database?.close());

const dueDate = plainDateStringSchema.make("2027-01-07");
const dueAt = getPassReminderDueAt(dueDate);
const activatedAt = dueAt.subtract({ hours: 1 });
const flow = automationFlowFixture({
  trigger: { _tag: "EntryPackExpiring" },
  steps: [{ _tag: "Send", id: "send" }],
});

describe.skipIf(!database)("pass reminder intake on PostgreSQL", () => {
  if (database === null) return;

  const { pool } = database;
  const provider = makeEngineDotypos();
  const fixtures = makeEngineFixtures(
    database,
    provider,
    "pass-reminder-intake"
  );
  const kit = automationLifecycleTestKit(database, { now: activatedAt });

  const seedPass = async (
    customer: DotyposCustomerId,
    unclaimed = false,
    existingHolder?: string
  ) => {
    const id = orderIdSchema.make(crypto.randomUUID());
    const holder = existingHolder ?? crypto.randomUUID();
    const buyer = unclaimed ? crypto.randomUUID() : holder;
    if (existingHolder === undefined) {
      await pool.query(
        "insert into customer_accounts (id, dotypos_customer_id) values ($1, $2)",
        [holder, customer]
      );
      await pool.query(
        `insert into auth."user" (id, name, email, email_verified)
         values ($1, 'Synthetic holder', $2, true)`,
        [holder, testEmailAddress(holder)]
      );
    }
    if (unclaimed) {
      await pool.query("insert into customer_accounts (id) values ($1)", [
        buyer,
      ]);
    }
    await pool.query(
      `insert into orders (id, kind, dotypos_customer_id, payment_state, fulfillment_state, fulfilled_at)
       values ($1, 'pass-purchase', $2, 'complimentary', 'fulfilled', now())`,
      [id, customer]
    );
    await pool.query(
      `insert into pass_purchases (id, buyer_account_id, holder_account_id, product, tier,
         entry_count, status, valid_from, valid_until, quote, locale, created_at, gift_issued_at)
       values ($1, $2, $3, 'entry-pack', 'open-space', 5, 'active',
         '2026-12-11', '2027-01-15', '{}', 'en-US', now(),
         case when $2 <> $3 then now() end)`,
      [id, buyer, holder]
    );
    return { id, holder };
  };

  const seedVersion = async () => {
    const { campaignId } = await kit.seedDraft();
    const permit = Effect.provideService(
      PassReminderWritesOpen,
      Effect.succeed(true)
    );
    await kit.run(
      kit
        .lifecycle((lifecycle) => lifecycle.updateFlow({ campaignId, flow }))
        .pipe(permit)
    );
    const previewId = await kit.seedPreview(campaignId, {
      status: "completed",
    });
    await kit.run(
      kit
        .lifecycle((lifecycle) =>
          lifecycle.activate({ campaignId, previewId, activatedBy: null })
        )
        .pipe(permit)
    );
    const { rows } = await pool.query(
      "select active_version_id from email_campaign_automations where campaign_id = $1",
      [campaignId]
    );
    return {
      campaignId,
      versionId: automationVersionIdSchema.make(rows[0].active_version_id),
    };
  };

  test("consumes retained pass occurrences after Prague midnight on the rollback floor", async () => {
    // A rollback from the writer retains its database migration.
    await pool.query(
      "drop index if exists email_campaign_automation_runs_one_open_run_idx"
    );
    const afterMidnight = dueAt.add({ hours: 15 });
    const eligible = await fixtures.addCustomer("eligible");
    const noConsent = await fixtures.addCustomer(
      "consent-revoked-before-intake"
    );
    const unclaimedGift = await fixtures.addCustomer("unclaimed-gift");
    const { id, holder } = await seedPass(eligible);
    const secondPass = await seedPass(eligible, false, holder);
    await seedPass(noConsent);
    await seedPass(unclaimedGift, true);
    const targets = [await seedVersion(), await seedVersion()];
    const queue = makeAutomationUnitQueueFake();
    const liveOpen = Effect.map(currentInstant, (now) =>
      now.equals(afterMidnight)
    );
    const layer = await automationScenarioLayer({
      database,
      dotypos: provider,
      queue,
      kinds: ["pass-reminder-intake"],
      planning: [],
      passReminderGate: Layer.succeed(CoworkPassesReleaseGate, {
        isOpen: liveOpen,
        decision: liveOpen,
      }),
      passReminderReads: PassReminderReads.Default.pipe(
        Layer.provide(
          Layer.merge(
            database.layer,
            Layer.mock(AdvisoryAvailabilityInventory, {})
          )
        )
      ),
    });
    const planned = targets.map((target) =>
      plannedPassReminderPage({ ...target, kind: "entry-pack", dueDate })
    );
    const write = Effect.flatMap(WorkspaceDatabase, ({ transaction }) =>
      transaction(planAutomationUnits(planned, dueAt))
    );
    await Promise.all([
      runEngineAt(write, layer, dueAt),
      runEngineAt(write, layer, dueAt),
    ]);
    await pool.query(
      "update customer_marketing_consents set withdrawn_at = $2 where dotypos_customer_id = $1",
      [noConsent, afterMidnight.toString()]
    );
    await runEngineAt(planAndProcess(queue), layer, afterMidnight);
    await runEngineAt(write, layer, afterMidnight);
    await runEngineAt(planAndProcess(queue), layer, afterMidnight);
    const { rows } = await pool.query(
      `select trigger_pass_id, pass_reminder_context, dotypos_customer_id,
              trigger_at = $1::timestamptz as original_fire
       from email_campaign_automation_runs where trigger_pass_id is not null`,
      [dueAt.toString()]
    );
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining(
        [id, secondPass.id].map((passId) => ({
          trigger_pass_id: passId,
          original_fire: true,
          dotypos_customer_id: eligible,
          pass_reminder_context: {
            copyVersion: 1,
            holderAccountId: holder,
            holderVersion: 0,
            tier: "open-space",
            endsOn: "2027-01-14",
            product: "entry-pack",
            remainingEntries: 5,
            totalEntries: 5,
          },
        }))
      )
    );
  });
});
