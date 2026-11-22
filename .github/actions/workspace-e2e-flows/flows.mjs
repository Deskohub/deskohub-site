/**
 * Single source of truth for Workspace E2E flow identifiers, PR description
 * parsing, flow set operations, and GitHub commit status encoding.
 *
 * Kept dependency-free ESM so GitHub Actions workflows can run it directly
 * from `github.workflow_sha` without checking out PR code or installing
 * packages, while the Workspace E2E runner imports the exact same rules.
 */

export const WORKSPACE_E2E_FLOW_IDS = Object.freeze([
  "checkout-cowork",
  "checkout-meeting-room",
  "checkout-office",
  "payments",
  "discounts",
  "referrals",
  "agent-booking",
  "account",
  "admin",
  "email-campaigns",
  "access-codes",
  "public-site",
  "webkit",
]);

export const WORKSPACE_E2E_FLOW_SHORT_CODES = Object.freeze({
  "checkout-cowork": "cc",
  "checkout-meeting-room": "cm",
  "checkout-office": "co",
  payments: "py",
  discounts: "ds",
  referrals: "rf",
  "agent-booking": "ab",
  account: "ac",
  admin: "ad",
  "email-campaigns": "ec",
  "access-codes": "ax",
  "public-site": "ps",
  webkit: "wk",
});

export const WORKSPACE_E2E_STATUS_MAX_LENGTH = 140;
export const WORKSPACE_E2E_SUPERSEDED_DESCRIPTION =
  "Superseded by a newer PR head before E2E finished";

const flowIdSet = new Set(WORKSPACE_E2E_FLOW_IDS);
const flowIdByShortCode = new Map(
  Object.entries(WORKSPACE_E2E_FLOW_SHORT_CODES).map(([id, code]) => [code, id])
);
const flowOrderIndex = new Map(
  WORKSPACE_E2E_FLOW_IDS.map((id, index) => [id, index])
);

const sortUniqueFlowIds = (ids) =>
  [...new Set(ids)].sort(
    (left, right) =>
      (flowOrderIndex.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (flowOrderIndex.get(right) ?? Number.MAX_SAFE_INTEGER)
  );

const buildFlowSelection = (selected) => {
  const ordered = sortUniqueFlowIds(selected);
  if (ordered.length === 0) {
    return {
      ok: true,
      kind: "none",
      flows: "none",
      selected: [],
      runE2E: false,
      installWebkit: false,
    };
  }
  if (ordered.length === WORKSPACE_E2E_FLOW_IDS.length) {
    return {
      ok: true,
      kind: "all",
      flows: "all",
      selected: [...WORKSPACE_E2E_FLOW_IDS],
      runE2E: true,
      installWebkit: true,
    };
  }
  return {
    ok: true,
    kind: "subset",
    flows: ordered.join(","),
    selected: ordered,
    runE2E: true,
    installWebkit: ordered.includes("webkit"),
  };
};

export const validFlowListMessage = () =>
  `Valid values: all, none, or a list from: ${WORKSPACE_E2E_FLOW_IDS.join(", ")}`;

export const parseFlowTokens = (tokens) => {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    return {
      ok: false,
      error: `The ## E2E flows section must list at least one flow, all, or none. ${validFlowListMessage()}`,
    };
  }
  const unknown = [];
  let hasAll = false;
  let hasNone = false;
  const flows = [];

  for (const rawToken of tokens) {
    const token = String(rawToken).trim();
    if (token === "all") {
      hasAll = true;
    } else if (token === "none") {
      hasNone = true;
    } else if (flowIdSet.has(token)) {
      flows.push(token);
    } else {
      unknown.push(token);
    }
  }

  if (unknown.length > 0) {
    return {
      ok: false,
      error: `Unknown E2E flow(s): ${unknown.join(", ")}. ${validFlowListMessage()}`,
    };
  }
  if (hasAll && (hasNone || flows.length > 0)) {
    return {
      ok: false,
      error:
        "Cannot combine `all` with `none` or specific flows in ## E2E flows.",
    };
  }
  if (hasNone && flows.length > 0) {
    return {
      ok: false,
      error: "Cannot combine `none` with specific flows in ## E2E flows.",
    };
  }
  if (hasAll) {
    return buildFlowSelection(WORKSPACE_E2E_FLOW_IDS);
  }
  if (hasNone) {
    return buildFlowSelection([]);
  }
  return buildFlowSelection(flows);
};

export const parseFlowsInput = (raw) => {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    return {
      ok: false,
      error: `E2E flows input is empty. ${validFlowListMessage()}`,
    };
  }
  const parts = trimmed.split(",").map((part) => part.trim());
  if (parts.some((part) => part.length === 0)) {
    return {
      ok: false,
      error: `E2E flows input contains an empty entry. ${validFlowListMessage()}`,
    };
  }
  return parseFlowTokens(parts);
};

// Per GFM, ATX headings allow at most 3 leading spaces; 4+ spaces or a leading
// tab is an indented code block rather than a visible heading.
const sectionHeadingPattern = /^ {0,3}##[ \t]+e2e[ \t]+flows[ \t]*:?[ \t]*$/i;
const anyHeadingPattern = /^ {0,3}#{1,6}[ \t]+/;
const fenceOpenPattern = /^ {0,3}(`{3,}|~{3,})/;
const indentedCodeLinePattern = /^(?: {4,}|\t)/;
const bulletPattern = /^ {0,3}[-*][ \t]+`?([^\s`:]+)`?(?:[ \t]*:[ \t]*\S.*)?$/;

const scanVisibleLines = (lines) => {
  const visible = [];
  let fenceChar = "";
  let fenceLength = 0;
  let previousBlank = true;
  let inIndentedCode = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fenceChar) {
      const closePattern = new RegExp(
        `^ {0,3}${fenceChar}{${fenceLength},}[ \\t]*$`
      );
      if (closePattern.test(line)) {
        fenceChar = "";
        fenceLength = 0;
        previousBlank = false;
      }
      visible.push({ index, line, code: true });
      continue;
    }

    const fenceMatch = fenceOpenPattern.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      // Backtick info strings cannot contain backticks in GFM.
      if (marker[0] !== "`" || !line.slice(fenceMatch[0].length).includes("`")) {
        fenceChar = marker[0];
        fenceLength = marker.length;
        inIndentedCode = false;
        previousBlank = false;
        visible.push({ index, line, code: true });
        continue;
      }
    }

    const isBlank = /^[ \t]*$/.test(line);
    if (isBlank) {
      previousBlank = true;
      visible.push({ index, line, code: inIndentedCode });
      continue;
    }

    if ((previousBlank || inIndentedCode) && indentedCodeLinePattern.test(line)) {
      inIndentedCode = true;
      previousBlank = false;
      visible.push({ index, line, code: true });
      continue;
    }

    inIndentedCode = false;
    previousBlank = false;
    visible.push({ index, line, code: false });
  }

  return visible;
};

export const parsePrBodyE2EFlows = (body) => {
  const text = String(body ?? "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const scanned = scanVisibleLines(lines);
  const headingIndices = [];

  for (const entry of scanned) {
    if (!entry.code && sectionHeadingPattern.test(entry.line)) {
      headingIndices.push(entry.index);
    }
  }

  if (headingIndices.length === 0) {
    return {
      ok: false,
      error: `Missing \`## E2E flows\` section in the PR description. ${validFlowListMessage()}`,
    };
  }
  if (headingIndices.length > 1) {
    return {
      ok: false,
      error:
        "Found more than one `## E2E flows` section in the PR description; keep exactly one.",
    };
  }

  const start = headingIndices[0] + 1;
  let end = lines.length;
  for (let index = start; index < scanned.length; index += 1) {
    const entry = scanned[index];
    if (!entry.code && anyHeadingPattern.test(entry.line)) {
      end = index;
      break;
    }
  }

  const sectionBody = lines
    .slice(start, end)
    .join("\n")
    .replace(/<!--[\s\S]*?-->/g, "");
  const tokens = [];

  for (const rawLine of sectionBody.split("\n")) {
    if (/^[ \t]*$/.test(rawLine)) continue;
    if (indentedCodeLinePattern.test(rawLine)) {
      return {
        ok: false,
        error: `Invalid indented line in \`## E2E flows\`: "${rawLine.trim()}". Use top-level bullet items like \`- admin\`, \`- all\`, or \`- none\`.`,
      };
    }
    const line = rawLine.replace(/[ \t]+$/, "");
    const match = bulletPattern.exec(line);
    if (!match) {
      return {
        ok: false,
        error: `Invalid entry in \`## E2E flows\`: "${line.trim()}". Use bullet items like \`- admin\`, \`- all\`, or \`- none\`.`,
      };
    }
    tokens.push(match[1]);
  }

  return parseFlowTokens(tokens);
};

const formatScopeSuffix = (base, selected) => {
  const ordered = sortUniqueFlowIds(selected);
  if (ordered.length === 0) return `${base} [flows: none]`;
  if (ordered.length === WORKSPACE_E2E_FLOW_IDS.length) return base;
  const named = `${base} [flows: ${ordered.join(",")}]`;
  if (named.length <= WORKSPACE_E2E_STATUS_MAX_LENGTH) return named;
  const codes = ordered.map((id) => WORKSPACE_E2E_FLOW_SHORT_CODES[id]);
  return `${base} [codes: ${codes.join(",")}]`;
};

export const formatE2EStatusDescription = ({ kind, flows, sourceSha }) => {
  if (kind === "skipped-none") {
    return "Protected preview E2E skipped [flows: none]";
  }
  const parsed =
    flows === undefined || flows === ""
      ? buildFlowSelection(WORKSPACE_E2E_FLOW_IDS)
      : parseFlowsInput(flows);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  if (kind === "passed") {
    return formatScopeSuffix("Protected preview E2E passed", parsed.selected);
  }
  if (kind === "partial") {
    return formatScopeSuffix(
      "Protected preview E2E partial; more flows required",
      parsed.selected
    );
  }
  if (kind === "running") {
    return formatScopeSuffix(
      "Protected preview E2E is running",
      parsed.selected
    );
  }
  if (kind === "failed") {
    return formatScopeSuffix("Protected preview E2E failed", parsed.selected);
  }
  if (kind === "same-tree-passed") {
    const shortSha = String(sourceSha ?? "").slice(0, 7);
    if (!/^[0-9a-f]{7}$/.test(shortSha)) {
      throw new Error("Invalid sourceSha for same-tree status description");
    }
    return formatScopeSuffix(
      `Same tree as ${shortSha}, which passed E2E`,
      parsed.selected
    );
  }
  throw new Error(`Unsupported status description kind: ${kind}`);
};

const parseScopeTag = (tag) => {
  if (!tag) return [...WORKSPACE_E2E_FLOW_IDS];
  const flowsMatch = /^\[flows:\s*([^\]]+)\]$/.exec(tag);
  if (flowsMatch) {
    const parsed = parseFlowsInput(flowsMatch[1]);
    return parsed.ok ? parsed.selected : null;
  }
  const codesMatch = /^\[codes:\s*([^\]]+)\]$/.exec(tag);
  if (codesMatch) {
    const codes = codesMatch[1].split(",").map((part) => part.trim());
    if (
      codes.length === 0 ||
      codes.some((code) => !flowIdByShortCode.has(code))
    ) {
      return null;
    }
    return sortUniqueFlowIds(codes.map((code) => flowIdByShortCode.get(code)));
  }
  return null;
};

const statusPatterns = [
  {
    kind: "passed",
    pattern:
      /^Protected preview E2E passed(?:\s+(\[(?:flows|codes):[^\]]+\]))?$/,
  },
  {
    kind: "partial",
    pattern:
      /^Protected preview E2E partial; more flows required(?:\s+(\[(?:flows|codes):[^\]]+\]))?$/,
  },
  {
    kind: "running",
    pattern:
      /^Protected preview E2E is running(?:\s+(\[(?:flows|codes):[^\]]+\]))?$/,
  },
  {
    kind: "failed",
    pattern:
      /^Protected preview E2E failed(?:\s+(\[(?:flows|codes):[^\]]+\]))?$/,
  },
  {
    kind: "carried-passed",
    pattern:
      /^Same tree as ([0-9a-f]{7}), which passed E2E(?:\s+(\[(?:flows|codes):[^\]]+\]))?$/,
  },
];

export const classifyE2EStatusDescription = (description) => {
  const text = String(description ?? "");
  if (text === WORKSPACE_E2E_SUPERSEDED_DESCRIPTION) {
    return { kind: "superseded" };
  }
  if (text === "Protected preview E2E skipped [flows: none]") {
    return { kind: "skipped-none", selected: [] };
  }
  for (const { kind, pattern } of statusPatterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    if (kind === "carried-passed") {
      const selected = parseScopeTag(match[2]);
      if (selected === null) return { kind: "other" };
      return { kind, selected, sourceSha: match[1] };
    }
    const selected = parseScopeTag(match[1]);
    if (selected === null) return { kind: "other" };
    return { kind, selected };
  }
  return { kind: "other" };
};

export const unionFlowIds = (...lists) =>
  sortUniqueFlowIds(lists.flatMap((list) => list));

export const diffFlowIds = (requested, covered) => {
  const coveredSet = new Set(covered);
  return sortUniqueFlowIds(requested).filter((id) => !coveredSet.has(id));
};

export const summarizeCommitStatuses = (
  statuses,
  {
    context = "Workspace E2E",
    creator = "github-actions[bot]",
    includeCarried = false,
  } = {}
) => {
  const relevant = (Array.isArray(statuses) ? statuses : []).filter(
    (status) =>
      status &&
      status.context === context &&
      status.creator?.login === creator
  );

  const latest = relevant[0] ?? null;
  let latestRunKind = null;
  let latestRunState = null;
  let runningFlowIds = [];
  // Track the newest terminal verdict per flow so a later failure for a flow
  // always invalidates an earlier pass for that flow.
  const decidedFlows = new Set();
  const realPassedFlowIds = [];
  const carriedPassedFlowIds = [];
  let carriedSourceSha = "";

  for (const status of relevant) {
    const classified = classifyE2EStatusDescription(status.description);
    if (classified.kind === "superseded") {
      if (latestRunKind === null) {
        latestRunKind = "superseded";
        latestRunState = "superseded";
      }
      continue;
    }
    if (
      (classified.kind === "passed" && status.state === "success") ||
      (classified.kind === "partial" && status.state === "failure")
    ) {
      if (latestRunKind === null) {
        latestRunKind = classified.kind;
        latestRunState = status.state;
      }
      for (const flow of classified.selected) {
        if (!decidedFlows.has(flow)) {
          decidedFlows.add(flow);
          realPassedFlowIds.push(flow);
        }
      }
      continue;
    }
    if (
      includeCarried &&
      classified.kind === "carried-passed" &&
      status.state === "success"
    ) {
      if (latestRunKind === null) {
        latestRunKind = "carried-passed";
        latestRunState = "success";
      }
      let addedFromCarry = false;
      for (const flow of classified.selected) {
        if (!decidedFlows.has(flow)) {
          decidedFlows.add(flow);
          carriedPassedFlowIds.push(flow);
          addedFromCarry = true;
        }
      }
      if (addedFromCarry && !carriedSourceSha) {
        carriedSourceSha = classified.sourceSha ?? "";
      }
      continue;
    }
    if (classified.kind === "running" && status.state === "pending") {
      if (latestRunKind === null) {
        latestRunKind = "running";
        latestRunState = "pending";
        runningFlowIds = [...classified.selected];
      }
      continue;
    }
    if (
      classified.kind === "failed" &&
      (status.state === "failure" || status.state === "error")
    ) {
      if (latestRunKind === null) {
        latestRunKind = "failed";
        latestRunState = status.state;
      }
      for (const flow of classified.selected) {
        if (!decidedFlows.has(flow)) {
          decidedFlows.add(flow);
        }
      }
    }
  }

  const realPassed = buildFlowSelection(realPassedFlowIds);
  const carriedPassed = buildFlowSelection(carriedPassedFlowIds);
  const allPassed = buildFlowSelection([
    ...realPassedFlowIds,
    ...carriedPassedFlowIds,
  ]);
  const running = buildFlowSelection(runningFlowIds);
  const coverageSource =
    realPassed.selected.length > 0 && carriedPassedFlowIds.length === 0
      ? "real"
      : carriedPassedFlowIds.length > 0
        ? "carried"
        : "none";

  return {
    latestState: latest?.state ?? "",
    latestDescription: latest?.description ?? "",
    latestKind: latest
      ? classifyE2EStatusDescription(latest.description).kind
      : "",
    latestRunKind: latestRunKind ?? "",
    latestRunState: latestRunState ?? "",
    passedFlows: allPassed.selected,
    passedFlowsCsv: allPassed.flows,
    realPassedFlows: realPassed.selected,
    realPassedFlowsCsv: realPassed.flows,
    carriedPassedFlows: carriedPassed.selected,
    carriedPassedFlowsCsv: carriedPassed.flows,
    carriedSourceSha,
    coverageSource,
    runningFlows: running.selected,
    runningFlowsCsv: running.flows,
    anyPassed: allPassed.selected.length > 0,
  };
};
