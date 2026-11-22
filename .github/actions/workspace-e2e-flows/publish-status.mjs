#!/usr/bin/env node
/**
 * Coordinated status reconciler and CAS publisher for `Workspace E2E`.
 *
 * Every writer that can publish `Workspace E2E` (`publish-final-status`,
 * `publish-status-without-run`, and `sync-pr-e2e-flows`) runs through this
 * helper so that:
 * 1. Success requires affirmative live evidence of PR head, valid `## E2E flows`,
 *    the current Vercel deployment's current status (never falling through from
 *    an unresolved deployment or treating lookup failure as valid), readable
 *    head commit-status history, and un-invalidated flow coverage.
 * 2. Every `success` write performs post-write verification against fresh PR,
 *    deployment, and commit-status reads while excluding all tentative writes
 *    from this process. If a concurrent edit, validation failure, deployment
 *    change, real run failure, or active rerun interleaved between read and
 *    write, it immediately applies the verified decision (preserving any
 *    dispatch action and preserving the active run's original `target_url`
 *    when restoring `pending`), or fails closed after bounded retries.
 * 3. Delayed failure paths (`publish-final-status` failure and
 *    `publish-status-without-run` failure) reconcile against the live PR
 *    selection while retaining any real run failure in commit-status history.
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

/**
 * Resolves the current (newest) Vercel deployment's current (newest) status
 * for `sha`. Never falls through from an unresolved (`in_progress`, `queued`,
 * `pending`) current deployment or status to an older deployment or status.
 */
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
  if (vercelDeployments.length === 0) {
    return { state: "pending", previewUrl: "" };
  }
  const currentDeployment = vercelDeployments[0];
  const statusesRes = ghApiJson([
    `${repoApi}/deployments/${currentDeployment.id}/statuses`,
  ]);
  if (!statusesRes.ok || !Array.isArray(statusesRes.data)) {
    return { state: "unavailable", previewUrl: "" };
  }
  if (statusesRes.data.length === 0) {
    return { state: "pending", previewUrl: "" };
  }
  const currentStatus = statusesRes.data[0];
  if (
    currentStatus?.state === "success" &&
    (currentStatus?.environment_url ?? "") !== ""
  ) {
    return {
      state: "success",
      previewUrl: String(currentStatus.environment_url).replace(/\/+$/, ""),
    };
  }
  if (
    currentStatus?.state === "inactive" &&
    currentStatus?.description === "Skipped - Not affected"
  ) {
    return { state: "skipped", previewUrl: "" };
  }
  if (currentStatus?.state === "failure" || currentStatus?.state === "error") {
    return { state: "failed", previewUrl: "" };
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

/**
 * Removes every tentative status posted by THIS process during the current CAS
 * loop so no retry can ever treat its own tentative `success` as proof of a
 * pass when another writer interleaved a failure or active rerun.
 */
const stripTentativePosts = (statuses, tentativePosts) => {
  if (!Array.isArray(statuses) || statuses.length === 0) return [];
  if (tentativePosts.length === 0) return statuses;
  const remainingTentative = [...tentativePosts];
  const filtered = [];
  for (const status of statuses) {
    const matchIndex = remainingTentative.findIndex((post) => {
      if (post.id != null) {
        return status?.id === post.id;
      }
      return (
        status?.context === "Workspace E2E" &&
        status?.creator?.login === "github-actions[bot]" &&
        status?.state === post.state &&
        status?.description === post.description &&
        status?.target_url === post.targetUrl
      );
    });
    if (matchIndex !== -1) {
      remainingTentative.splice(matchIndex, 1);
      continue;
    }
    filtered.push(status);
  }
  return filtered;
};

const findActiveRunForFlows = (summary, flowIds) => {
  if (!Array.isArray(summary.activeRuns) || summary.activeRuns.length === 0) {
    return null;
  }
  const wanted = new Set(flowIds);
  const matching = summary.activeRuns.find((run) =>
    run.flows.some((flow) => wanted.has(flow))
  );
  return matching ?? summary.activeRuns[0];
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
 * deployment change, real failure, or active rerun.
 */
const publishWithCasReconcile = ({ sha, readSnapshot, decide }) => {
  const tentativePosts = [];
  let pendingSnapshot = null;

  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const rawBefore = pendingSnapshot ?? readSnapshot();
    pendingSnapshot = null;
    const before = {
      ...rawBefore,
      statuses: rawBefore.statusesOk
        ? stripTentativePosts(rawBefore.statuses, tentativePosts)
        : rawBefore.statuses,
    };
    const decision = decide(before);
    if (decision.skipPost) {
      return decision;
    }

    const postTargetUrl = decision.targetUrl || runUrl;
    const posted = postCommitStatus(sha, {
      context: "Workspace E2E",
      state: decision.state,
      description: decision.description,
      targetUrl: postTargetUrl,
    });

    if (decision.state !== "success") {
      return decision;
    }

    tentativePosts.push({
      id: posted && typeof posted === "object" ? posted.id : undefined,
      state: decision.state,
      description: decision.description,
      targetUrl: postTargetUrl,
    });

    // Verify linearizability against fresh live state after every success write,
    // excluding all tentative posts made by this process.
    const rawAfter = readSnapshot();
    const after = {
      ...rawAfter,
      statuses: rawAfter.statusesOk
        ? stripTentativePosts(rawAfter.statuses, tentativePosts)
        : rawAfter.statuses,
    };
    const verifyDecision = decide(after);

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

    // If a concurrent active rerun appeared right beneath our tentative
    // success, restore the pending running status preserving the active run's
    // original target_url so that run still recognizes ownership when it ends.
    if (verifyDecision.restorePendingDescription) {
      const pendingTargetUrl = verifyDecision.restorePendingTargetUrl || runUrl;
      postCommitStatus(sha, {
        context: "Workspace E2E",
        state: "pending",
        description: verifyDecision.restorePendingDescription,
        targetUrl: pendingTargetUrl,
      });
      return {
        state: "pending",
        description: verifyDecision.restorePendingDescription,
        targetUrl: pendingTargetUrl,
      };
    }

    // If verification produced a non-success decision (for example a concurrent
    // real run failure, PR invalidation, or widened flows requiring dispatch),
    // apply that exact decision immediately and preserve its dispatchAction.
    if (!verifyDecision.skipPost && verifyDecision.state !== "success") {
      const finalTargetUrl = verifyDecision.targetUrl || runUrl;
      postCommitStatus(sha, {
        context: "Workspace E2E",
        state: verifyDecision.state,
        description: verifyDecision.description,
        targetUrl: finalTargetUrl,
      });
      return verifyDecision;
    }

    if (verifyDecision.skipPost) {
      if (
        after.prOk &&
        before.prOk &&
        before.pr?.head?.sha === after.pr?.head?.sha &&
        (before.pr?.body ?? "") === (after.pr?.body ?? "") &&
        sameDeployment
      ) {
        return decision;
      }
      // PR became ineligible or state shifted without authorizing our tentative
      // success: do not leave our tentative success on top if we cannot prove it.
      if (!after.prOk) {
        postCommitStatus(sha, {
          context: "Workspace E2E",
          state: "failure",
          description: PR_UNAVAILABLE_DESCRIPTION,
          targetUrl: runUrl,
        });
        return { state: "failure", description: PR_UNAVAILABLE_DESCRIPTION };
      }
      // Re-run loop on the fresh snapshot if it changed.
      pendingSnapshot = rawAfter;
      continue;
    }

    // Verification wants a different `success` description; reuse `rawAfter`
    // (with tentativePosts stripped at the top of the next iteration).
    pendingSnapshot = rawAfter;
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
      statuses:
        statusesRes.ok && Array.isArray(statusesRes.data)
          ? statusesRes.data
          : [],
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
        if (!statusesOk) {
          return {
            state: "failure",
            description: STATUSES_UNAVAILABLE_DESCRIPTION,
          };
        }

        const headSha = String(pr?.head?.sha ?? "");
        const prBody = String(pr?.body ?? "");

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

        // Never overwrite a newer active run started by a DIFFERENT workflow run
        // for any requested flow.
        const foreignActiveRun = summary.activeRuns.find(
          (run) =>
            run.targetUrl !== "" &&
            run.targetUrl !== runUrl &&
            run.flows.some((flow) => parsedPr.selected.includes(flow))
        );
        if (foreignActiveRun) {
          return {
            skipPost: true,
            restorePendingDescription: foreignActiveRun.description,
            restorePendingTargetUrl: foreignActiveRun.targetUrl,
          };
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
  // run failure in commit status history, then ALWAYS reconcile against the
  // live PR selection (even if the initial PR body was invalid and was fixed to
  // `none` before reconciliation).
  const initialPr = prNumber ? fetchPr(prNumber) : { ok: false };
  const initialHeadSha = initialPr.ok
    ? String(initialPr.data?.head?.sha ?? "")
    : "";
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

  if (prNumber) {
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
          return { skipPost: true };
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
          // Ensure the failure we just posted is reflected even under read-after-write
          // lag, while preserving server order if it is already present (so a newer
          // foreign active run above it is still recognized).
          const alreadyRecorded = statuses.some(
            (status) =>
              status?.context === "Workspace E2E" &&
              status?.creator?.login === "github-actions[bot]" &&
              status?.state === "failure" &&
              status?.description === failedDescription &&
              (status?.target_url == null || status?.target_url === runUrl)
          );
          const effectiveStatuses = alreadyRecorded
            ? statuses
            : [
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
          const foreignActiveRun = summary.activeRuns.find(
            (run) =>
              run.targetUrl !== "" &&
              run.targetUrl !== runUrl &&
              run.flows.some((flow) => parsedPr.selected.includes(flow))
          );
          if (foreignActiveRun) {
            return {
              state: "pending",
              description: foreignActiveRun.description,
              targetUrl: foreignActiveRun.targetUrl,
            };
          }
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

  if (!prNumber) {
    postCommitStatus(targetSha, {
      context: "Workspace E2E",
      state: statusState === "success" ? "failure" : statusState,
      description:
        statusState === "success"
          ? PR_UNAVAILABLE_DESCRIPTION
          : statusDescription,
      targetUrl: runUrl,
    });
    return;
  }

  const readSnapshot = () => {
    const prRes = fetchPr(prNumber);
    const deployment = fetchDeploymentState(targetSha);
    const statusesRes = fetchCommitStatuses(targetSha);
    return {
      prOk: prRes.ok && Boolean(prRes.data),
      pr: prRes.ok ? prRes.data : null,
      statusesOk: statusesRes.ok && Array.isArray(statusesRes.data),
      statuses:
        statusesRes.ok && Array.isArray(statusesRes.data)
          ? statusesRes.data
          : [],
      deployment,
    };
  };

  // Delayed failure path: reconcile against live PR, deployment, and commit
  // status history so a stale failure (e.g. invalid metadata that was fixed to
  // `none` while this job queued) never overwrites a valid live decision.
  if (statusState !== "success") {
    publishWithCasReconcile({
      sha: targetSha,
      readSnapshot,
      decide: ({ prOk, pr, statusesOk, statuses, deployment }) => {
        if (!prOk) {
          return { state: statusState, description: statusDescription };
        }
        const headSha = String(pr?.head?.sha ?? "");
        if (/^[0-9a-f]{40}$/.test(headSha) && headSha !== targetSha) {
          return { state: statusState, description: statusDescription };
        }
        if (deployment.state === "failed") {
          return {
            state: "failure",
            description: DEPLOYMENT_FAILED_DESCRIPTION,
          };
        }
        if (deployment.state !== "success" && deployment.state !== "skipped") {
          return { state: statusState, description: statusDescription };
        }
        const parsedPr = parsePrBodyE2EFlows(String(pr?.body ?? ""));
        if (!parsedPr.ok) {
          return { state: statusState, description: statusDescription };
        }
        if (parsedPr.flows === "none") {
          return {
            state: "success",
            description: formatE2EStatusDescription({ kind: "skipped-none" }),
          };
        }
        if (statusesOk) {
          const summary = summarizeCommitStatuses(statuses, {
            includeCarried: true,
          });
          if (diffFlowIds(parsedPr.selected, summary.realPassedFlows).length === 0) {
            return {
              state: "success",
              description: formatE2EStatusDescription({
                kind: "passed",
                flows: summary.realPassedFlowsCsv,
              }),
            };
          }
          const carriedCovers =
            summary.carriedSourceSha !== "" &&
            diffFlowIds(parsedPr.selected, summary.carriedPassedFlows).length ===
              0;
          if (carriedCovers) {
            return {
              state: "success",
              description: formatE2EStatusDescription({
                kind: "same-tree-passed",
                flows: summary.carriedPassedFlowsCsv,
                sourceSha: summary.carriedSourceSha,
              }),
            };
          }
          const inFlightCovered = unionFlowIds(
            summary.realPassedFlows,
            summary.runningFlows
          );
          if (
            summary.runningFlows.length > 0 &&
            diffFlowIds(parsedPr.selected, inFlightCovered).length === 0
          ) {
            const activeRun = findActiveRunForFlows(
              summary,
              diffFlowIds(parsedPr.selected, summary.realPassedFlows)
            );
            return {
              skipPost: true,
              restorePendingDescription: activeRun?.description,
              restorePendingTargetUrl: activeRun?.targetUrl,
            };
          }
        }
        return { state: statusState, description: statusDescription };
      },
    });
    return;
  }

  const classified = classifyE2EStatusDescription(statusDescription);

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
        if (!statusesOk) {
          return {
            state: "failure",
            description: STATUSES_UNAVAILABLE_DESCRIPTION,
          };
        }
        const summary = summarizeCommitStatuses(statuses, {
          includeCarried: false,
        });
        const runningSet = new Set(summary.runningFlows);
        if (parsedPr.selected.some((id) => runningSet.has(id))) {
          const activeRun = findActiveRunForFlows(summary, parsedPr.selected);
          return {
            skipPost: true,
            restorePendingDescription: activeRun?.description,
            restorePendingTargetUrl: activeRun?.targetUrl,
          };
        }
        const failedSet = new Set(summary.failedFlows);
        if (parsedPr.selected.some((id) => failedSet.has(id))) {
          return {
            state: "failure",
            description: "Protected preview E2E failed on this commit",
          };
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
      statuses:
        statusesRes.ok && Array.isArray(statusesRes.data)
          ? statusesRes.data
          : [],
      deployment,
    };
  };

  const outcome = publishWithCasReconcile({
    sha: headSha,
    readSnapshot,
    decide: ({ prOk, pr, statusesOk, statuses, deployment }) => {
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
      const deploymentResolved =
        deployment.state === "success" || deployment.state === "skipped";

      if (requestedFlows === "none") {
        if (deploymentResolved) {
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
        if (!deploymentResolved) {
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
        }
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
        if (!deploymentResolved) {
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
        }
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
        summary.runningFlows.length > 0 &&
        diffFlowIds(requestedSelected, inFlightCovered).length === 0;
      if (coveredByRunning) {
        const activeRun = findActiveRunForFlows(summary, missingReal);
        appendSummary(
          `An in-progress Workspace E2E run already covers ${requestedFlows}`
        );
        // If an intermediate status (for example another flow's pass) sits on
        // top of the still-active run, restore `pending` preserving the active
        // run's original target_url so merge stays blocked and the run retains
        // ownership when it finishes.
        if (summary.latestState !== "pending" && activeRun) {
          return {
            state: "pending",
            description: activeRun.description,
            targetUrl: activeRun.targetUrl || runUrl,
          };
        }
        return {
          skipPost: true,
          restorePendingDescription: activeRun?.description,
          restorePendingTargetUrl: activeRun?.targetUrl,
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
        return {
          state: "failure",
          description:
            "PR E2E flows changed; starting Workspace E2E for missing flows",
          dispatchAction: {
            sha: headSha,
            url: deployment.previewUrl,
            ref: headRef,
            flows: dispatchFlows,
          },
        };
      }

      if (deployment.state === "skipped") {
        // Honor failures and active reruns recorded directly on the head SHA
        // before considering an older same-tree commit.
        const headFailedSet = new Set(summary.failedFlows);
        if (requestedSelected.some((id) => headFailedSet.has(id))) {
          return {
            state: "failure",
            description: "Protected preview E2E failed on this commit",
          };
        }
        const headRunningSet = new Set(summary.runningFlows);
        if (requestedSelected.some((id) => headRunningSet.has(id))) {
          const activeRun = findActiveRunForFlows(summary, missingReal);
          return {
            state: "failure",
            description:
              "Workspace E2E is still running for part of this commit; wait or deploy its Workspace preview",
            restorePendingDescription: activeRun?.description,
            restorePendingTargetUrl: activeRun?.targetUrl,
          };
        }

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

  if (outcome.dispatchAction) {
    const dispatchRes = ghExec([
      "workflow",
      "run",
      "workspace-e2e.yml",
      "--repo",
      repoSlug,
      "--ref",
      "main",
      "-f",
      `sha=${outcome.dispatchAction.sha}`,
      "-f",
      `url=${outcome.dispatchAction.url}`,
      "-f",
      `ref=${outcome.dispatchAction.ref}`,
      "-f",
      `flows=${outcome.dispatchAction.flows}`,
    ]);
    if (!dispatchRes.ok) {
      throw new Error(
        `Failed to dispatch workspace-e2e.yml: ${dispatchRes.stderr}`
      );
    }
    appendSummary(
      `Dispatched Workspace E2E for ${outcome.dispatchAction.sha.slice(0, 7)} with missing flows: \`${outcome.dispatchAction.flows}\``
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
