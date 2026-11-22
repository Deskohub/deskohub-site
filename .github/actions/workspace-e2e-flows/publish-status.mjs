#!/usr/bin/env node
/**
 * Coordinated status reconciler and CAS publisher for `Workspace E2E`.
 *
 * Every writer that can publish `Workspace E2E: success` (`publish-final-status`,
 * `publish-status-without-run`, and `sync-pr-e2e-flows`) runs through this
 * helper so that:
 * 1. Success requires affirmative live evidence of PR head, valid `## E2E flows`,
 *    applicable Vercel deployment state (never treating lookup failure as valid),
 *    and un-invalidated flow coverage.
 * 2. Every `success` write performs post-write verification against fresh PR,
 *    deployment, and commit status reads; if a concurrent edit, validation
 *    failure, deployment failure, or active rerun interleaved between read and
 *    write, it immediately reconciles and overwrites the stale success (or fails
 *    closed after bounded retries).
 * 3. Failed runs on the current head always record their actual run failure in
 *    commit status history first, then reconcile against the live PR selection
 *    (for example `none` on a valid preview).
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import {
  classifyE2EStatusDescription,
  diffFlowIds,
  formatE2EStatusDescription,
  parseFlowsInput,
  parsePrBodyE2EFlows,
  summarizeCommitStatuses,
  unionFlowIds,
  WORKSPACE_E2E_FLOW_IDS,
  WORKSPACE_E2E_SUPERSEDED_DESCRIPTION,
} from "./flows.mjs";

const INVALID_FLOWS_DESCRIPTION =
  "Invalid or missing ## E2E flows in PR description; list valid flows, all, or none";
const DEPLOYMENT_FAILED_DESCRIPTION =
  "Vercel preview deployment failed; fix or redeploy it to run E2E";
const DEPLOYMENT_UNAVAILABLE_DESCRIPTION =
  "Vercel preview deployment state could not be verified; re-run the failed jobs";
const PR_UNAVAILABLE_DESCRIPTION =
  "Workspace E2E could not verify PR state; re-run the failed jobs";
const STATUSES_UNAVAILABLE_DESCRIPTION =
  "Workspace E2E could not verify commit statuses; re-run the failed jobs";
const RACE_FAILURE_DESCRIPTION =
  "Workspace E2E status raced with concurrent updates; re-run this check";
const PREVIEW_ENVIRONMENT =
  process.env.PREVIEW_ENVIRONMENT || "Preview – deskohub-workspace-site";
const MAX_CAS_ATTEMPTS = 3;

const repoSlug = process.env.GITHUB_REPOSITORY ?? "";
const repoApi = `repos/${repoSlug}`;
const runUrl = `${process.env.GITHUB_SERVER_URL ?? ""}/${repoSlug}/actions/runs/${process.env.GITHUB_RUN_ID ?? ""}`;

const appendSummary = (line) => {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    appendFileSync(summaryPath, `${line}\n`, "utf8");
  }
};

const ghExec = (args) => {
  try {
    const stdout = execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout };
  } catch (error) {
    return {
      ok: false,
      stderr: error?.stderr ? String(error.stderr) : String(error),
    };
  }
};

const ghApiJson = (args, { slurp = false } = {}) => {
  const fullArgs = [
    "api",
    ...(slurp ? ["--paginate", "--slurp"] : []),
    "-H",
    "Accept: application/vnd.github+json",
    ...args,
  ];
  const res = ghExec(fullArgs);
  if (!res.ok) return { ok: false, error: res.stderr };
  try {
    const parsed = JSON.parse(res.stdout || "null");
    if (slurp) {
      return {
        ok: true,
        data: Array.isArray(parsed) ? parsed.flat() : [],
      };
    }
    return { ok: true, data: parsed };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
};

const fetchPr = (prNumber) => ghApiJson([`${repoApi}/pulls/${prNumber}`]);

const fetchCommitStatuses = (sha) =>
  ghApiJson([`${repoApi}/commits/${sha}/statuses?per_page=100`], {
    slurp: true,
  });

const fetchPrCommits = (prNumber) =>
  ghApiJson([`${repoApi}/pulls/${prNumber}/commits?per_page=100`], {
    slurp: true,
  });

const fetchDeploymentState = (sha) => {
  const deploymentsRes = ghApiJson([
    "--method",
    "GET",
    `${repoApi}/deployments`,
    "-f",
    `sha=${sha}`,
    "-f",
    `environment=${PREVIEW_ENVIRONMENT}`,
    "-f",
    "per_page=100",
  ]);
  if (!deploymentsRes.ok || !Array.isArray(deploymentsRes.data)) {
    return { state: "unavailable", previewUrl: "" };
  }
  const vercelDeployments = deploymentsRes.data.filter(
    (entry) => entry?.creator?.login === "vercel[bot]" && entry?.id != null
  );
  for (const deployment of vercelDeployments) {
    const statusesRes = ghApiJson([
      `${repoApi}/deployments/${deployment.id}/statuses`,
    ]);
    if (!statusesRes.ok || !Array.isArray(statusesRes.data)) {
      return { state: "unavailable", previewUrl: "" };
    }
    for (const status of statusesRes.data) {
      if (status?.state === "success" && (status?.environment_url ?? "") !== "") {
        return {
          state: "success",
          previewUrl: String(status.environment_url).replace(/\/+$/, ""),
        };
      }
      if (
        status?.state === "inactive" &&
        status?.description === "Skipped - Not affected"
      ) {
        return { state: "skipped", previewUrl: "" };
      }
      if (status?.state === "failure" || status?.state === "error") {
        return { state: "failed", previewUrl: "" };
      }
    }
  }
  return { state: "pending", previewUrl: "" };
};

const postCommitStatus = (sha, { context, state, description, targetUrl }) => {
  const res = ghApiJson([
    "--method",
    "POST",
    `${repoApi}/statuses/${sha}`,
    "-f",
    `state=${state}`,
    "-f",
    `context=${context}`,
    "-f",
    `description=${description}`,
    "-f",
    `target_url=${targetUrl}`,
  ]);
  if (!res.ok) {
    throw new Error(
      `Failed to publish ${context} status (${state}): ${res.error}`
    );
  }
  return res.data;
};

const toCanonicalFlows = (flowIds) => {
  if (flowIds.length === 0) return "none";
  if (flowIds.length === WORKSPACE_E2E_FLOW_IDS.length) return "all";
  return flowIds.join(",");
};

const stripOwnTopStatus = (statuses, posted, { state, description, targetUrl }) => {
  if (!Array.isArray(statuses) || statuses.length === 0) return [];
  const head = statuses[0];
  const matchesId =
    posted && typeof posted === "object" && posted.id != null && head?.id === posted.id;
  const matchesFields =
    head?.context === "Workspace E2E" &&
    head?.creator?.login === "github-actions[bot]" &&
    head?.state === state &&
    head?.description === description &&
    (head?.target_url == null || head?.target_url === targetUrl);
  if (matchesId || matchesFields) {
    return statuses.slice(1);
  }
  return statuses;
};

/**
 * Evaluates a same-tree source commit's real runs against `requestedSelected`.
 * Preserves genuine partial passes and fails closed when a requested flow failed
 * or is still running.
 */
const evaluateSameTreeCommit = (commitSha, commitStatuses, requestedSelected) => {
  const summary = summarizeCommitStatuses(commitStatuses, {
    includeCarried: false,
  });
  if (summary.latestRunKind === "" || summary.latestRunKind === "superseded") {
    return null;
  }
  const realMissing = diffFlowIds(requestedSelected, summary.realPassedFlows);
  if (realMissing.length === 0) {
    return {
      state: "success",
      description: formatE2EStatusDescription({
        kind: "same-tree-passed",
        flows: summary.realPassedFlowsCsv,
        sourceSha: commitSha,
      }),
    };
  }
  const failedSet = new Set(summary.failedFlows);
  if (requestedSelected.some((id) => failedSet.has(id))) {
    return {
      state: "failure",
      description: `Same tree as ${commitSha.slice(0, 7)}, which failed E2E`,
    };
  }
  const runningSet = new Set(summary.runningFlows);
  if (requestedSelected.some((id) => runningSet.has(id))) {
    return {
      state: "failure",
      description: `Same tree as ${commitSha.slice(0, 7)}, whose E2E is still running; rerun this check after it ends`,
    };
  }
  if (summary.latestRunKind === "failed") {
    return {
      state: "failure",
      description: `Same tree as ${commitSha.slice(0, 7)}, which failed E2E`,
    };
  }
  if (summary.latestRunKind === "running") {
    return {
      state: "failure",
      description: `Same tree as ${commitSha.slice(0, 7)}, whose E2E is still running; rerun this check after it ends`,
    };
  }
  return {
    state: "failure",
    description: `Same tree as ${commitSha.slice(0, 7)} lacks required E2E flows; deploy its Workspace preview`,
  };
};

/**
 * Executes a decide -> post -> post-write CAS verify loop so that no writer can
 * leave a stale `success` status after a concurrent PR edit, validation failure,
 * deployment change, or active rerun.
 */
const publishWithCasReconcile = ({ sha, readSnapshot, decide }) => {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const before = readSnapshot();
    const decision = decide(before);
    if (decision.skipPost) {
      return decision;
    }

    const posted = postCommitStatus(sha, {
      context: "Workspace E2E",
      state: decision.state,
      description: decision.description,
      targetUrl: runUrl,
    });

    if (decision.state !== "success") {
      return decision;
    }

    // Verify linearizability against fresh live state after every success write.
    const after = readSnapshot();
    const statusesWithoutOurs = after.statusesOk
      ? stripOwnTopStatus(after.statuses, posted, {
          state: decision.state,
          description: decision.description,
          targetUrl: runUrl,
        })
      : after.statuses;
    const verifyDecision = decide({
      ...after,
      statuses: statusesWithoutOurs,
    });

    const samePr =
      before.prOk &&
      after.prOk &&
      before.pr?.head?.sha === after.pr?.head?.sha &&
      (before.pr?.body ?? "") === (after.pr?.body ?? "");
    const sameDeployment = before.deployment.state === after.deployment.state;

    if (
      samePr &&
      sameDeployment &&
      !verifyDecision.skipPost &&
      verifyDecision.state === "success" &&
      verifyDecision.description === decision.description
    ) {
      return decision;
    }

    // If a concurrent active rerun appeared right beneath our speculative
    // success, restore the pending running status rather than leaving green.
    if (verifyDecision.restorePendingDescription) {
      postCommitStatus(sha, {
        context: "Workspace E2E",
        state: "pending",
        description: verifyDecision.restorePendingDescription,
        targetUrl: runUrl,
      });
      return {
        state: "pending",
        description: verifyDecision.restorePendingDescription,
      };
    }

    if (verifyDecision.skipPost) {
      // Another writer already made the status converge cleanly, or PR became
      // ineligible; only accept if not leaving our speculative success behind
      // without authorization.
      if (
        after.prOk &&
        before.prOk &&
        before.pr?.head?.sha === after.pr?.head?.sha &&
        (before.pr?.body ?? "") === (after.pr?.body ?? "") &&
        sameDeployment
      ) {
        return decision;
      }
    }
  }

  postCommitStatus(sha, {
    context: "Workspace E2E",
    state: "failure",
    description: RACE_FAILURE_DESCRIPTION,
    targetUrl: runUrl,
  });
  return { state: "failure", description: RACE_FAILURE_DESCRIPTION };
};

const runPublishFinalStatus = () => {
  const targetSha = process.env.TARGET_SHA ?? "";
  const prNumber = process.env.PR_NUMBER ?? "";
  const statusState = process.env.STATUS_STATE ?? "failure";
  const allocationDescription = process.env.ALLOCATION_DESCRIPTION ?? "";
  const supersededDescription =
    process.env.SUPERSEDED_DESCRIPTION || WORKSPACE_E2E_SUPERSEDED_DESCRIPTION;
  const effectiveFlows = (process.env.FLOWS ?? "").trim() || "all";

  const parsedRunFlows = parseFlowsInput(effectiveFlows);
  if (!parsedRunFlows.ok) {
    throw new Error(parsedRunFlows.error);
  }

  const readSnapshot = () => {
    const prRes = prNumber ? fetchPr(prNumber) : { ok: false };
    const statusesRes = fetchCommitStatuses(targetSha);
    const deployment = fetchDeploymentState(targetSha);
    return {
      prOk: prRes.ok && Boolean(prRes.data),
      pr: prRes.ok ? prRes.data : null,
      statusesOk: statusesRes.ok && Array.isArray(statusesRes.data),
      statuses: statusesRes.ok && Array.isArray(statusesRes.data) ? statusesRes.data : [],
      deployment,
    };
  };

  if (statusState === "success") {
    publishWithCasReconcile({
      sha: targetSha,
      readSnapshot,
      decide: ({ prOk, pr, statusesOk, statuses, deployment }) => {
        if (!prOk) {
          return { state: "failure", description: PR_UNAVAILABLE_DESCRIPTION };
        }
        if (deployment.state === "failed") {
          return {
            state: "failure",
            description: DEPLOYMENT_FAILED_DESCRIPTION,
          };
        }
        if (deployment.state !== "success") {
          return {
            state: "failure",
            description: DEPLOYMENT_UNAVAILABLE_DESCRIPTION,
          };
        }

        const headSha = String(pr?.head?.sha ?? "");
        const prBody = String(pr?.body ?? "");

        if (effectiveFlows !== "all" && !statusesOk) {
          return {
            state: "failure",
            description: STATUSES_UNAVAILABLE_DESCRIPTION,
          };
        }

        const summary = summarizeCommitStatuses(statuses, {
          includeCarried: false,
        });
        const union =
          effectiveFlows === "all"
            ? [...WORKSPACE_E2E_FLOW_IDS]
            : unionFlowIds(summary.realPassedFlows, parsedRunFlows.selected);
        const unionCsv = toCanonicalFlows(union);

        if (/^[0-9a-f]{40}$/.test(headSha) && headSha !== targetSha) {
          // The head moved after this run passed; preserve this SHA's real pass
          // without evaluating the newer head's PR body against it.
          return {
            state: "success",
            description: formatE2EStatusDescription({
              kind: "passed",
              flows: unionCsv,
            }),
          };
        }

        const parsedPr = parsePrBodyE2EFlows(prBody);
        if (!parsedPr.ok) {
          return { state: "failure", description: INVALID_FLOWS_DESCRIPTION };
        }

        // Never overwrite a newer active run started by another workflow run.
        if (
          statusesOk &&
          summary.latestRunKind === "running" &&
          summary.runningTargetUrl !== "" &&
          summary.runningTargetUrl !== runUrl
        ) {
          const runningSet = new Set(summary.runningFlows);
          if (parsedPr.selected.some((id) => runningSet.has(id))) {
            return {
              skipPost: true,
              restorePendingDescription: summary.runningDescription,
            };
          }
        }

        const missingFromUnion = diffFlowIds(parsedPr.selected, union);
        if (missingFromUnion.length === 0) {
          return {
            state: "success",
            description: formatE2EStatusDescription({
              kind: "passed",
              flows: unionCsv,
            }),
          };
        }

        return {
          state: "failure",
          description: formatE2EStatusDescription({
            kind: "partial",
            flows: unionCsv,
          }),
        };
      },
    });

    postCommitStatus(targetSha, {
      context: "Workspace E2E allocation",
      state: statusState,
      description: allocationDescription,
      targetUrl: runUrl,
    });
    return;
  }

  // Failure path: check if superseded first; otherwise ALWAYS record the actual
  // run failure in commit status history, then reconcile against the live PR
  // selection (for example `none` on a valid preview).
  const initialPr = prNumber ? fetchPr(prNumber) : { ok: false };
  const initialHeadSha = initialPr.ok ? String(initialPr.data?.head?.sha ?? "") : "";
  if (/^[0-9a-f]{40}$/.test(initialHeadSha) && initialHeadSha !== targetSha) {
    postCommitStatus(targetSha, {
      context: "Workspace E2E",
      state: "failure",
      description: supersededDescription,
      targetUrl: runUrl,
    });
    postCommitStatus(targetSha, {
      context: "Workspace E2E allocation",
      state: "failure",
      description: supersededDescription,
      targetUrl: runUrl,
    });
    return;
  }

  const failedDescription = formatE2EStatusDescription({
    kind: "failed",
    flows: effectiveFlows,
  });
  postCommitStatus(targetSha, {
    context: "Workspace E2E",
    state: "failure",
    description: failedDescription,
    targetUrl: runUrl,
  });

  // Reconcile the live PR selection after recording the failure outcome.
  if (initialPr.ok) {
    const initialParsed = parsePrBodyE2EFlows(String(initialPr.data?.body ?? ""));
    if (initialParsed.ok) {
      publishWithCasReconcile({
        sha: targetSha,
        readSnapshot,
        decide: ({ prOk, pr, statusesOk, statuses, deployment }) => {
          if (!prOk) {
            return { skipPost: true };
          }
          const headSha = String(pr?.head?.sha ?? "");
          if (/^[0-9a-f]{40}$/.test(headSha) && headSha !== targetSha) {
            return { skipPost: true };
          }
          const parsedPr = parsePrBodyE2EFlows(String(pr?.body ?? ""));
          if (!parsedPr.ok) {
            return { state: "failure", description: INVALID_FLOWS_DESCRIPTION };
          }
          if (parsedPr.flows === "none") {
            if (deployment.state === "success" || deployment.state === "skipped") {
              return {
                state: "success",
                description: formatE2EStatusDescription({
                  kind: "skipped-none",
                }),
              };
            }
            return { skipPost: true };
          }
          if (deployment.state === "success" && statusesOk) {
            // Always include the failure we just posted so eventual consistency
            // cannot resurrect an older pass for the flows that just failed.
            const effectiveStatuses = [
              {
                context: "Workspace E2E",
                creator: { login: "github-actions[bot]" },
                description: failedDescription,
                state: "failure",
                target_url: runUrl,
              },
              ...statuses,
            ];
            const summary = summarizeCommitStatuses(effectiveStatuses, {
              includeCarried: false,
            });
            const missingReal = diffFlowIds(
              parsedPr.selected,
              summary.realPassedFlows
            );
            if (missingReal.length === 0) {
              return {
                state: "success",
                description: formatE2EStatusDescription({
                  kind: "passed",
                  flows: summary.realPassedFlowsCsv,
                }),
              };
            }
          }
          return { skipPost: true };
        },
      });
    }
  }

  postCommitStatus(targetSha, {
    context: "Workspace E2E allocation",
    state: statusState,
    description: allocationDescription,
    targetUrl: runUrl,
  });
};

const runPublishStatusWithoutRun = () => {
  const targetSha = process.env.TARGET_SHA ?? "";
  const prNumber = process.env.PR_NUMBER ?? "";
  const statusState = process.env.STATUS_STATE ?? "failure";
  const statusDescription = process.env.STATUS_DESCRIPTION ?? "";

  if (statusState !== "success") {
    postCommitStatus(targetSha, {
      context: "Workspace E2E",
      state: statusState,
      description: statusDescription,
      targetUrl: runUrl,
    });
    return;
  }

  if (!prNumber) {
    postCommitStatus(targetSha, {
      context: "Workspace E2E",
      state: "failure",
      description: PR_UNAVAILABLE_DESCRIPTION,
      targetUrl: runUrl,
    });
    return;
  }

  const classified = classifyE2EStatusDescription(statusDescription);

  const readSnapshot = () => {
    const prRes = fetchPr(prNumber);
    const deployment = fetchDeploymentState(targetSha);
    const statusesRes = fetchCommitStatuses(targetSha);
    return {
      prOk: prRes.ok && Boolean(prRes.data),
      pr: prRes.ok ? prRes.data : null,
      statusesOk: statusesRes.ok && Array.isArray(statusesRes.data),
      statuses: statusesRes.ok && Array.isArray(statusesRes.data) ? statusesRes.data : [],
      deployment,
    };
  };

  publishWithCasReconcile({
    sha: targetSha,
    readSnapshot,
    decide: ({ prOk, pr, statusesOk, statuses, deployment }) => {
      if (!prOk) {
        return { state: "failure", description: PR_UNAVAILABLE_DESCRIPTION };
      }
      if (deployment.state === "failed") {
        return {
          state: "failure",
          description: DEPLOYMENT_FAILED_DESCRIPTION,
        };
      }
      if (deployment.state !== "success" && deployment.state !== "skipped") {
        return {
          state: "failure",
          description: DEPLOYMENT_UNAVAILABLE_DESCRIPTION,
        };
      }

      const headSha = String(pr?.head?.sha ?? "");
      if (/^[0-9a-f]{40}$/.test(headSha) && headSha !== targetSha) {
        return { state: "success", description: statusDescription };
      }

      const parsedPr = parsePrBodyE2EFlows(String(pr?.body ?? ""));
      if (!parsedPr.ok) {
        return { state: "failure", description: INVALID_FLOWS_DESCRIPTION };
      }

      if (classified.kind === "skipped-none") {
        if (parsedPr.flows !== "none") {
          return {
            state: "failure",
            description:
              "PR E2E flows changed; run Workspace E2E for the newly requested flows",
          };
        }
        return { state: "success", description: statusDescription };
      }

      if (classified.kind === "carried-passed") {
        if (statusesOk) {
          const summary = summarizeCommitStatuses(statuses, {
            includeCarried: false,
          });
          if (summary.latestRunKind === "running") {
            return {
              skipPost: true,
              restorePendingDescription: summary.runningDescription,
            };
          }
          const failedSet = new Set(summary.failedFlows);
          if (parsedPr.selected.some((id) => failedSet.has(id))) {
            return {
              state: "failure",
              description: "Protected preview E2E failed on this commit",
            };
          }
        }
        const missing = diffFlowIds(parsedPr.selected, classified.selected);
        if (missing.length > 0) {
          return {
            state: "failure",
            description:
              "PR E2E flows changed; same-tree commit lacks newly requested E2E flows",
          };
        }
        return { state: "success", description: statusDescription };
      }

      return {
        state: "failure",
        description:
          "Workspace E2E status could not be verified; re-run the failed jobs",
      };
    },
  });
};

const isEligibleInternalPr = (pr) =>
  pr?.state === "open" &&
  pr?.draft === false &&
  pr?.head?.repo?.full_name === repoSlug &&
  pr?.user?.login !== "dependabot[bot]" &&
  !String(pr?.head?.ref ?? "").startsWith("dependabot/");

const runSyncPrFlows = () => {
  const prNumber = process.env.PR_NUMBER ?? "";
  const initialPrRes = fetchPr(prNumber);
  if (!initialPrRes.ok || !initialPrRes.data) {
    throw new Error(`Could not read PR #${prNumber}`);
  }
  const initialPr = initialPrRes.data;
  if (!isEligibleInternalPr(initialPr)) {
    process.stdout.write(
      `PR #${prNumber} is no longer an eligible open internal PR\n`
    );
    return;
  }

  const headSha = String(initialPr.head?.sha ?? "");
  const headRef = String(initialPr.head?.ref ?? "");
  if (!/^[0-9a-f]{40}$/.test(headSha)) {
    process.stderr.write(`PR #${prNumber} head SHA is invalid\n`);
    process.exit(1);
  }
  try {
    execFileSync("git", ["check-ref-format", "--branch", headRef], {
      stdio: "ignore",
    });
  } catch {
    process.stderr.write(`PR #${prNumber} head ref is invalid\n`);
    process.exit(1);
  }

  const initialParsed = parsePrBodyE2EFlows(String(initialPr.body ?? ""));
  if (!initialParsed.ok) {
    process.stderr.write(`${initialParsed.error}\n`);
    appendSummary(
      `Workspace E2E flow check failed for PR #${prNumber}: ${initialParsed.error}`
    );
    postCommitStatus(headSha, {
      context: "Workspace E2E",
      state: "failure",
      description: INVALID_FLOWS_DESCRIPTION,
      targetUrl: runUrl,
    });
    process.exit(1);
  }
  appendSummary(
    `PR #${prNumber} requests Workspace E2E flows: \`${initialParsed.flows}\``
  );

  const readSnapshot = () => {
    const prRes = fetchPr(prNumber);
    const statusesRes = fetchCommitStatuses(headSha);
    const deployment = fetchDeploymentState(headSha);
    return {
      prOk: prRes.ok && Boolean(prRes.data),
      pr: prRes.ok ? prRes.data : null,
      statusesOk: statusesRes.ok && Array.isArray(statusesRes.data),
      statuses: statusesRes.ok && Array.isArray(statusesRes.data) ? statusesRes.data : [],
      deployment,
    };
  };

  let dispatchAction = null;

  const outcome = publishWithCasReconcile({
    sha: headSha,
    readSnapshot,
    decide: ({ prOk, pr, statusesOk, statuses, deployment }) => {
      dispatchAction = null;
      if (!prOk) {
        return { state: "failure", description: PR_UNAVAILABLE_DESCRIPTION };
      }
      if (!isEligibleInternalPr(pr) || String(pr?.head?.sha ?? "") !== headSha) {
        return { skipPost: true };
      }
      const parsedPr = parsePrBodyE2EFlows(String(pr?.body ?? ""));
      if (!parsedPr.ok) {
        return {
          state: "failure",
          description: INVALID_FLOWS_DESCRIPTION,
          invalidPrError: parsedPr.error,
        };
      }
      if (!statusesOk) {
        return {
          state: "failure",
          description: STATUSES_UNAVAILABLE_DESCRIPTION,
        };
      }
      if (deployment.state === "failed") {
        return {
          state: "failure",
          description: DEPLOYMENT_FAILED_DESCRIPTION,
        };
      }
      if (deployment.state === "unavailable") {
        return {
          state: "failure",
          description: DEPLOYMENT_UNAVAILABLE_DESCRIPTION,
        };
      }

      const summary = summarizeCommitStatuses(statuses, {
        includeCarried: true,
      });
      const requestedFlows = parsedPr.flows;
      const requestedSelected = parsedPr.selected;

      if (requestedFlows === "none") {
        if (deployment.state === "success" || deployment.state === "skipped") {
          if (summary.latestState !== "success") {
            return {
              state: "success",
              description: formatE2EStatusDescription({ kind: "skipped-none" }),
            };
          }
          return { skipPost: true };
        }
        if (
          summary.latestState === "failure" &&
          summary.latestDescription === INVALID_FLOWS_DESCRIPTION
        ) {
          return {
            state: "pending",
            description: "Waiting for Vercel preview to resolve E2E",
          };
        }
        return { skipPost: true };
      }

      const missingReal = diffFlowIds(requestedSelected, summary.realPassedFlows);
      if (missingReal.length === 0) {
        if (
          summary.latestState !== "success" ||
          summary.latestKind === "skipped-none"
        ) {
          return {
            state: "success",
            description: formatE2EStatusDescription({
              kind: "passed",
              flows: summary.realPassedFlowsCsv,
            }),
          };
        }
        return { skipPost: true };
      }

      const carriedCoversRequested =
        summary.carriedSourceSha !== "" &&
        diffFlowIds(requestedSelected, summary.carriedPassedFlows).length === 0;
      if (carriedCoversRequested) {
        if (
          summary.latestState !== "success" ||
          summary.latestKind === "skipped-none"
        ) {
          return {
            state: "success",
            description: formatE2EStatusDescription({
              kind: "same-tree-passed",
              flows: summary.carriedPassedFlowsCsv,
              sourceSha: summary.carriedSourceSha,
            }),
          };
        }
        return { skipPost: true };
      }

      const inFlightCovered = unionFlowIds(
        summary.realPassedFlows,
        summary.runningFlows
      );
      const coveredByRunning =
        summary.latestRunKind === "running" &&
        diffFlowIds(requestedSelected, inFlightCovered).length === 0;
      if (coveredByRunning) {
        appendSummary(
          `An in-progress Workspace E2E run already covers ${requestedFlows}`
        );
        return {
          skipPost: true,
          restorePendingDescription: summary.runningDescription,
        };
      }

      if (deployment.state === "success") {
        const dispatchFlows = toCanonicalFlows(missingReal);
        if (!dispatchFlows || dispatchFlows === "none") {
          return {
            state: "failure",
            description:
              "Workspace E2E could not determine missing flows; re-run this check",
          };
        }
        dispatchAction = {
          sha: headSha,
          url: deployment.previewUrl,
          ref: headRef,
          flows: dispatchFlows,
        };
        return {
          state: "failure",
          description:
            "PR E2E flows changed; starting Workspace E2E for missing flows",
        };
      }

      if (deployment.state === "skipped") {
        const commitsRes = fetchPrCommits(prNumber);
        if (!commitsRes.ok || !Array.isArray(commitsRes.data)) {
          return {
            state: "failure",
            description:
              "Workspace E2E could not read PR commits; deploy its Workspace preview",
          };
        }
        const targetCommit = commitsRes.data.find(
          (commit) => commit?.sha === headSha
        );
        const targetTree = targetCommit?.commit?.tree?.sha ?? "";
        if (!targetTree) {
          return {
            state: "failure",
            description:
              "Head missing from this PR's commit list (GitHub lists 250 at most); deploy its Workspace preview to run E2E",
          };
        }
        const sameTreeShas = commitsRes.data
          .filter(
            (commit) =>
              commit?.sha &&
              commit.sha !== headSha &&
              commit?.commit?.tree?.sha === targetTree
          )
          .map((commit) => commit.sha)
          .reverse();
        for (const candidateSha of sameTreeShas) {
          const candidateStatusesRes = fetchCommitStatuses(candidateSha);
          if (!candidateStatusesRes.ok) {
            return {
              state: "failure",
              description: STATUSES_UNAVAILABLE_DESCRIPTION,
            };
          }
          const result = evaluateSameTreeCommit(
            candidateSha,
            candidateStatusesRes.data,
            requestedSelected
          );
          if (result) {
            return result;
          }
        }
        return {
          state: "failure",
          description:
            "Vercel skipped this SHA and no E2E-tested commit has its tree; deploy its Workspace preview",
        };
      }

      // deployment.state === "pending"
      if (
        summary.latestState === "failure" &&
        summary.latestDescription === INVALID_FLOWS_DESCRIPTION
      ) {
        return {
          state: "pending",
          description: "Waiting for Vercel preview to run E2E",
        };
      }
      return { skipPost: true };
    },
  });

  if (outcome.invalidPrError) {
    process.stderr.write(`${outcome.invalidPrError}\n`);
    process.exit(1);
  }

  if (dispatchAction) {
    const dispatchRes = ghExec([
      "workflow",
      "run",
      "workspace-e2e.yml",
      "--repo",
      repoSlug,
      "--ref",
      "main",
      "-f",
      `sha=${dispatchAction.sha}`,
      "-f",
      `url=${dispatchAction.url}`,
      "-f",
      `ref=${dispatchAction.ref}`,
      "-f",
      `flows=${dispatchAction.flows}`,
    ]);
    if (!dispatchRes.ok) {
      throw new Error(
        `Failed to dispatch workspace-e2e.yml: ${dispatchRes.stderr}`
      );
    }
    appendSummary(
      `Dispatched Workspace E2E for ${dispatchAction.sha.slice(0, 7)} with missing flows: \`${dispatchAction.flows}\``
    );
  }
};

const [mode] = process.argv.slice(2);
switch (mode) {
  case "publish-final-status":
    runPublishFinalStatus();
    break;
  case "publish-status-without-run":
    runPublishStatusWithoutRun();
    break;
  case "sync-pr-flows":
    runSyncPrFlows();
    break;
  default:
    process.stderr.write(
      `Unknown publish-status mode: ${mode ?? "<missing>"}\n`
    );
    process.exit(1);
}
