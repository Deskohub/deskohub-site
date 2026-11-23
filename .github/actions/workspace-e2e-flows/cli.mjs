#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  classifyE2EStatusDescription,
  diffFlowIds,
  findCoveringCarriedSource,
  formatE2EStatusDescription,
  parseFlowsInput,
  parsePrBodyE2EFlows,
  summarizeCommitStatuses,
  unionFlowIds,
  WORKSPACE_E2E_FLOW_IDS,
} from "./flows.mjs";

const [command] = process.argv.slice(2);

const writeJson = (value) => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

const readStdinJson = () => {
  const input = readFileSync(0, "utf8").trim();
  return input ? JSON.parse(input) : [];
};

const toCanonicalFlows = (flowIds) => {
  if (flowIds.length === 0) return "none";
  if (flowIds.length === WORKSPACE_E2E_FLOW_IDS.length) return "all";
  return flowIds.join(",");
};

const parseHttpHeaderAndBody = (raw) => {
  const text = String(raw ?? "");
  if (!/^HTTP\/\d(?:\.\d)?\s+\d{3}\b/.test(text)) {
    return { hasHeaders: false, headersText: "", bodyText: text };
  }
  const match = /\r?\n\r?\n/.exec(text);
  if (!match) {
    return { hasHeaders: true, headersText: text, bodyText: "" };
  }
  return {
    hasHeaders: true,
    headersText: text.slice(0, match.index),
    bodyText: text.slice(match.index + match[0].length),
  };
};

const parseNextLink = (headersText) => {
  for (const line of headersText.split(/\r?\n/)) {
    const match = /^link:\s*(.+)$/i.exec(line.trim());
    if (!match) continue;
    for (const part of match[1].split(",")) {
      const linkMatch = /^<([^>]+)>(.*)$/.exec(part.trim());
      if (linkMatch && /;\s*rel="next"(?:;|$)/i.test(linkMatch[2])) {
        return linkMatch[1];
      }
    }
  }
  return "";
};

/**
 * Fetches a paginated GitHub REST API JSON array one page at a time via
 * `gh api -i`. Each completed page is parsed and accumulated independently so
 * a failed or truncated later page (for example HTTP 502) never corrupts or
 * discards items already verified from earlier pages.
 */
const fetchPaginatedJson = (endpoint, extraArgs) => {
  const items = [];
  const seenUrls = new Set();
  let page = 1;
  let nextUrl = "";

  while (true) {
    const args = nextUrl
      ? [
          "api",
          "--method",
          "GET",
          "-i",
          "-H",
          "Accept: application/vnd.github+json",
          nextUrl,
        ]
      : [
          "api",
          "--method",
          "GET",
          "-i",
          "-H",
          "Accept: application/vnd.github+json",
          endpoint,
          ...extraArgs,
          "-f",
          "per_page=100",
          "-f",
          `page=${page}`,
        ];

    let stdout = "";
    try {
      stdout = execFileSync("gh", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      return { ok: false, items };
    }

    const initial = parseHttpHeaderAndBody(stdout);
    let effectiveHeaders = initial.headersText;
    let effectiveBody = initial.bodyText;
    while (
      initial.hasHeaders &&
      /^HTTP\/\d(?:\.\d)?\s+\d{3}\b/.test(effectiveBody)
    ) {
      const nested = parseHttpHeaderAndBody(effectiveBody);
      effectiveHeaders = nested.headersText;
      effectiveBody = nested.bodyText;
    }

    let parsed;
    try {
      parsed = JSON.parse(effectiveBody);
    } catch {
      return { ok: false, items };
    }
    if (!Array.isArray(parsed)) {
      return { ok: false, items };
    }
    items.push(...parsed);

    if (initial.hasHeaders) {
      const linkNext = parseNextLink(effectiveHeaders);
      if (!linkNext) {
        return { ok: true, items };
      }
      if (seenUrls.has(linkNext)) {
        return { ok: false, items };
      }
      seenUrls.add(linkNext);
      nextUrl = linkNext;
      page += 1;
      continue;
    }

    if (parsed.length < 100) {
      return { ok: true, items };
    }
    page += 1;
  }
};

switch (command) {
  case "parse-pr-body": {
    const result = parsePrBodyE2EFlows(process.env.PR_BODY ?? "");
    writeJson(result);
    if (!result.ok) process.exit(1);
    break;
  }
  case "parse-flows": {
    const result = parseFlowsInput(process.env.FLOWS_INPUT ?? "");
    writeJson(result);
    if (!result.ok) process.exit(1);
    break;
  }
  case "classify-status": {
    const classified = classifyE2EStatusDescription(
      process.env.STATUS_DESCRIPTION ?? ""
    );
    const requestedRaw = (process.env.REQUESTED_FLOWS ?? "").trim();
    let coversRequested = false;
    if (requestedRaw) {
      const parsedRequested = parseFlowsInput(requestedRaw);
      if (!parsedRequested.ok) {
        process.stderr.write(`${parsedRequested.error}\n`);
        process.exit(1);
      }
      if ("selected" in classified) {
        coversRequested =
          diffFlowIds(parsedRequested.selected, classified.selected).length ===
          0;
      }
    }
    writeJson({
      ...classified,
      coversRequested,
    });
    break;
  }
  case "format-status": {
    const description = formatE2EStatusDescription({
      kind: process.env.STATUS_KIND ?? "",
      flows: process.env.FLOWS ?? "",
      sourceSha: process.env.SOURCE_SHA ?? "",
    });
    process.stdout.write(`${description}\n`);
    break;
  }
  case "summarize-statuses": {
    const statuses = readStdinJson();
    const includeCarried = process.env.INCLUDE_CARRIED === "true";
    const summary = summarizeCommitStatuses(statuses, { includeCarried });

    const requestedRaw = (process.env.REQUESTED_FLOWS ?? "").trim();
    const addedRaw = (process.env.ADDED_FLOWS ?? "").trim();

    let union = summary.realPassedFlows;
    if (addedRaw) {
      const parsedAdded = parseFlowsInput(addedRaw);
      if (!parsedAdded.ok) {
        process.stderr.write(`${parsedAdded.error}\n`);
        process.exit(1);
      }
      union = unionFlowIds(summary.realPassedFlows, parsedAdded.selected);
    }

    let missing = [];
    let missingReal = [];
    let allCovered = false;
    let realCoversRequested = false;
    let carriedCoversRequested = false;
    let coveringCarriedSource = null;
    let unionCoversRequested = false;
    let coveredByRunning = false;
    let requestedHasFailed = false;
    let requestedHasRunning = false;
    if (requestedRaw) {
      const parsedRequested = parseFlowsInput(requestedRaw);
      if (!parsedRequested.ok) {
        process.stderr.write(`${parsedRequested.error}\n`);
        process.exit(1);
      }
      missing = diffFlowIds(parsedRequested.selected, summary.passedFlows);
      missingReal = diffFlowIds(
        parsedRequested.selected,
        summary.realPassedFlows
      );
      allCovered = missing.length === 0;
      realCoversRequested = missingReal.length === 0;
      coveringCarriedSource = findCoveringCarriedSource(
        summary.carriedSources,
        parsedRequested.selected
      );
      carriedCoversRequested = coveringCarriedSource !== null;
      unionCoversRequested =
        diffFlowIds(parsedRequested.selected, union).length === 0;
      const inFlightCovered = unionFlowIds(
        summary.realPassedFlows,
        summary.runningFlows
      );
      coveredByRunning =
        summary.runningFlows.length > 0 &&
        diffFlowIds(parsedRequested.selected, inFlightCovered).length === 0;
      const failedSet = new Set(summary.failedFlows);
      const runningSet = new Set(summary.runningFlows);
      requestedHasFailed = parsedRequested.selected.some((id) =>
        failedSet.has(id)
      );
      requestedHasRunning = parsedRequested.selected.some((id) =>
        runningSet.has(id)
      );
    }

    writeJson({
      ...summary,
      missingFlows: missing,
      missingFlowsCsv: toCanonicalFlows(missing),
      missingRealFlows: missingReal,
      missingRealFlowsCsv: toCanonicalFlows(missingReal),
      allCovered,
      realCoversRequested,
      carriedCoversRequested,
      coveringCarriedSource,
      unionCoversRequested,
      coveredByRunning,
      requestedHasFailed,
      requestedHasRunning,
      unionFlows: union,
      unionFlowsCsv: toCanonicalFlows(union),
    });
    break;
  }
  case "fetch-paginated-json": {
    const [endpoint, ...extraArgs] = process.argv.slice(3);
    if (!endpoint) {
      process.stderr.write("Missing endpoint for fetch-paginated-json\n");
      process.exit(1);
    }
    writeJson(fetchPaginatedJson(endpoint, extraArgs));
    break;
  }
  default: {
    process.stderr.write(
      `Unknown workspace-e2e-flows command: ${command ?? "<missing>"}\n`
    );
    process.exit(1);
  }
}
