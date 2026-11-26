import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Effect, Option } from "effect";
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
import { toWorkspaceE2EError } from "../errors";
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
  reconcileWorkspaceE2ECheckout,
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
    const reservation = await readReservationJournal(journalPath);
    return account !== undefined || reservation !== undefined;
  } catch {
    throw new Error("Unlimited pass cleanup could not read its journals");
  }
};

test("reconcile workspace checkout reservations", async ({
  environment,
  runContext,
  runEffect,
}) => {
  await runEffect(
    traceWorkspaceE2ESuiteCleanup({
      reconcileCheckout: Effect.gen(function* () {
        const span = yield* Effect.option(Effect.currentSpan);
        const runInPhase: typeof runEffect = (effect) =>
          runEffect(
            Option.isSome(span)
              ? effect.pipe(Effect.withParentSpan(span.value))
              : effect
          );
        yield* Effect.tryPromise({
          try: () => reconcileCheckout(runInPhase),
          catch: (cause) =>
            toWorkspaceE2EError("reconcile ordinary checkout", cause),
        });
      }),
      reconcileUnlimitedPass: Effect.tryPromise({
        try: reconcileUnlimitedPass,
        catch: (cause) =>
          toWorkspaceE2EError("reconcile Unlimited pass", cause),
      }),
    })
  );

  async function reconcileUnlimitedPass(signal: AbortSignal) {
    if (!(await readUnlimitedPassCleanupJournals())) return;
    try {
      await execFileAsync(
        "bun",
        [
          "--no-orphans",
          "--no-env-file",
          "--conditions=react-server",
          "e2e/playwright-checkout/unlimited-pass-cleanup.ts",
        ],
        {
          cwd: workspaceDir,
          env: { NODE_ENV: "test", ...toPlaywrightEnvironment(environment) },
          signal,
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

  async function reconcileCheckout(runInPhase: typeof runEffect) {
    const datasourceConfig = getDatasourceConfig(environment);
    try {
      // An automation journey whose case never reached its own finalizer could
      // leave an active automation behind. Its runs reference the booked
      // reservation, so they go before checkout cleanup.
      const automationJournals = await readWorkspaceE2ECaseJournals([
        automationReservationCaseId,
      ]);
      await runInPhase(
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
          runInPhase(
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
          return runInPhase(
            prepareCheckoutFlowCleanup({ datasourceConfig, flowStates })
          );
        },
        reconcile: ({ accountJournals, checkoutCleanup }) =>
          runInPhase(
            reconcileWorkspaceE2ECheckout({
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
