import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Effect } from "effect";
import { readWorkspaceE2EAccountJournal } from "../account/journal";
import {
  prepareWorkspaceE2EAccountJournalReconciliations,
  reconcileWorkspaceE2EAccountJournals,
} from "../account/reconcile";
import {
  cleanupPreparedCheckoutFlowStates,
  prepareCheckoutFlowCleanup,
} from "../cleanup";
import { getDatasourceConfig } from "../config";
import { toPlaywrightEnvironment } from "../e2e-env";
import {
  automationReservationCaseId,
  deleteRunAutomationJourneys,
} from "../email-campaigns/automation-reservation-case";
import { E2EDatabase } from "../integrations/database.service";
import { reservationIntentJournalPath } from "../reservation-intents";
import { readReservationJournal } from "../reservation-journal";
import { workspaceDir } from "../runtime";
import { workspaceE2ETimeouts } from "../timeouts";
import {
  unlimitedPassAutoRenewalCaseId,
  workspaceE2ECaseIds,
} from "./case-catalog";
import {
  runWorkspaceE2ECleanupWithPreparedCandidates,
  traceWorkspaceE2ESuiteCleanup,
} from "./cleanup-plan";
import { cleanupTest as test } from "./cleanup-runtime-fixtures";
import {
  unlimitedPassAutoRenewalJournalOwner,
  workspaceE2ECheckoutJournalOwners,
} from "./journal-owners";
import { readWorkspaceE2ECaseJournals } from "./run-plan";

const execFileAsync = promisify(execFile);

const readUnlimitedPassCleanupJournals = async () => {
  try {
    const journalPath = reservationIntentJournalPath(
      unlimitedPassAutoRenewalCaseId
    );
    if (!journalPath) throw new Error("Missing Unlimited pass journal path");
    const account = await readWorkspaceE2EAccountJournal(
      unlimitedPassAutoRenewalJournalOwner.ownerId
    );
    const intents = (await readReservationJournal(journalPath))
      ?.reservationIntents;
    return (
      account !== undefined ||
      (intents !== undefined && (!Array.isArray(intents) || intents.length > 0))
    );
  } catch {
    throw new Error("Unlimited pass cleanup could not read its journals");
  }
};

test("reconcile workspace checkout reservations", async ({
  environment,
  runContext,
  runEffect,
}) => {
  const failures: unknown[] = [];
  try {
    await reconcileCheckout();
  } catch (error) {
    failures.push(error);
  }
  try {
    if (await readUnlimitedPassCleanupJournals()) {
      try {
        await execFileAsync(
          "bun",
          [
            "--no-env-file",
            "--conditions=react-server",
            "e2e/playwright-checkout/unlimited-pass-cleanup.ts",
          ],
          {
            cwd: workspaceDir,
            env: { NODE_ENV: "test", ...toPlaywrightEnvironment(environment) },
            timeout:
              workspaceE2ETimeouts.unlimitedPassCase +
              workspaceE2ETimeouts.datasource,
          }
        );
      } catch (error) {
        // The child emits fixed diagnostics. Discard unexpected subprocess output.
        const diagnostic =
          error &&
          typeof error === "object" &&
          "stderr" in error &&
          typeof error.stderr === "string" &&
          /^Unlimited pass [a-zA-Z ]+\n$/.test(error.stderr)
            ? error.stderr.trim()
            : "Unlimited pass cleanup subprocess failed";
        throw new Error(diagnostic);
      }
    }
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Workspace checkout cleanup failed");

  async function reconcileCheckout() {
    const datasourceConfig = getDatasourceConfig(environment);
    try {
      // An automation journey whose case never reached its own finalizer could
      // leave an active automation behind. Its runs reference the booked
      // reservation, so they go before checkout cleanup.
      const automationJournals = await readWorkspaceE2ECaseJournals([
        automationReservationCaseId,
      ]);
      await runEffect(
        Effect.gen(function* () {
          const { db } = yield* E2EDatabase;
          yield* deleteRunAutomationJourneys({
            contacts: automationJournals.map((state) => state.data),
            datasourceConfig,
            db,
            runId: runContext.runId,
          });
        })
      );
    } finally {
      await runWorkspaceE2ECleanupWithPreparedCandidates({
        readAccountJournals: () =>
          runEffect(
            prepareWorkspaceE2EAccountJournalReconciliations(
              datasourceConfig,
              runContext.runId,
              workspaceE2ECheckoutJournalOwners.filter(
                ({ ownerId }) =>
                  ownerId !== unlimitedPassAutoRenewalJournalOwner.ownerId
              )
            )
          ),
        readCheckoutCleanup: async () => {
          const flowStates = await readWorkspaceE2ECaseJournals(
            workspaceE2ECaseIds.filter(
              (caseId) => caseId !== unlimitedPassAutoRenewalCaseId
            )
          );
          return runEffect(
            prepareCheckoutFlowCleanup({ datasourceConfig, flowStates })
          );
        },
        reconcile: ({ accountJournals, checkoutCleanup }) =>
          runEffect(
            traceWorkspaceE2ESuiteCleanup({
              cleanupCheckout: cleanupPreparedCheckoutFlowStates({
                datasourceConfig,
                prepared: checkoutCleanup,
                workflowError: undefined,
              }),
              reconcileAccountJournals:
                reconcileWorkspaceE2EAccountJournals(accountJournals),
            })
          ),
      });
    }
  }
});
