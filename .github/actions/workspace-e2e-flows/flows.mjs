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

// Per GFM Section 4.2, ATX headings allow at most 3 leading spaces and an
// optional closing sequence of `#` preceded by spaces/tabs and followed only
// by spaces/tabs. 4+ leading spaces or a leading tab is an indented code block.
const stripClosingAtxHashes = (line) => line.replace(/[ \t]+#+[ \t]*$/, "");
const sectionHeadingPattern = /^ {0,3}##[ \t]+e2e[ \t]+flows[ \t]*:?[ \t]*$/i;
const anyHeadingPattern = /^ {0,3}#{1,6}(?:[ \t]+.*|[ \t]*)$/;
const fenceOpenPattern = /^ {0,3}(`{3,}|~{3,})/;
const htmlCommentBlockStartPattern = /^ {0,3}<!--/;
const indentedCodeLinePattern = /^(?: {4,}|\t)/;
const bulletPattern = /^ {0,3}[-*][ \t]+`?([^\s`:]+)`?(?:[ \t]*:[ \t]*\S.*)?$/;

/**
 * Strips inline HTML comments (`<!-- ... -->`) outside backtick code spans,
 * and reports whether an unclosed `<!--` remains open at end of line.
 */
const stripInlineHtmlComments = (line, inCommentStart) => {
  let inComment = inCommentStart;
  let out = "";
  let i = 0;

  while (i < line.length) {
    if (inComment) {
      const closeIndex = line.indexOf("-->", i);
      if (closeIndex === -1) {
        return { text: out, inComment: true };
      }
      i = closeIndex + 3;
      inComment = false;
      continue;
    }

    if (line[i] === "`") {
      let tickEnd = i;
      while (tickEnd < line.length && line[tickEnd] === "`") tickEnd += 1;
      const tickCount = tickEnd - i;
      const marker = "`".repeat(tickCount);
      let search = tickEnd;
      let closing = -1;
      while (search < line.length) {
        const candidate = line.indexOf(marker, search);
        if (candidate === -1) break;
        const beforeOk = candidate === 0 || line[candidate - 1] !== "`";
        const afterOk =
          candidate + tickCount >= line.length ||
          line[candidate + tickCount] !== "`";
        if (beforeOk && afterOk) {
          closing = candidate;
          break;
        }
        search = candidate + 1;
      }
      if (closing !== -1) {
        out += line.slice(i, closing + tickCount);
        i = closing + tickCount;
        continue;
      }
      out += line.slice(i, tickEnd);
      i = tickEnd;
      continue;
    }

    if (line.startsWith("<!--", i)) {
      inComment = true;
      i += 4;
      continue;
    }

    out += line[i];
    i += 1;
  }

  return { text: out, inComment };
};

const scanVisibleLines = (lines) => {
  const visible = [];
  let fenceChar = "";
  let fenceLength = 0;
  let previousBlank = true;
  let inIndentedCode = false;
  let inHtmlCommentBlock = false;
  let inInlineComment = false;

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
      visible.push({ index, line, visibleLine: "", hidden: true });
      continue;
    }

    // GFM HTML block type 2 (`<!--` ... `-->`, or through EOF if unclosed).
    if (inHtmlCommentBlock) {
      if (line.includes("-->")) {
        inHtmlCommentBlock = false;
      }
      previousBlank = false;
      visible.push({ index, line, visibleLine: "", hidden: true });
      continue;
    }

    if (inInlineComment) {
      const stripped = stripInlineHtmlComments(line, true);
      inInlineComment = stripped.inComment;
      const isBlank = /^[ \t]*$/.test(stripped.text);
      previousBlank = isBlank;
      visible.push({
        index,
        line,
        visibleLine: stripped.text,
        hidden: isBlank,
      });
      continue;
    }

    const fenceMatch = fenceOpenPattern.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      // Backtick info strings cannot contain backticks in GFM.
      if (
        marker[0] !== "`" ||
        !line.slice(fenceMatch[0].length).includes("`")
      ) {
        fenceChar = marker[0];
        fenceLength = marker.length;
        inIndentedCode = false;
        previousBlank = false;
        visible.push({ index, line, visibleLine: "", hidden: true });
        continue;
      }
    }

    const isBlank = /^[ \t]*$/.test(line);
    if (isBlank) {
      previousBlank = true;
      visible.push({
        index,
        line,
        visibleLine: "",
        hidden: inIndentedCode,
      });
      continue;
    }

    if (
      (previousBlank || inIndentedCode) &&
      indentedCodeLinePattern.test(line)
    ) {
      inIndentedCode = true;
      previousBlank = false;
      visible.push({ index, line, visibleLine: "", hidden: true });
      continue;
    }

    inIndentedCode = false;

    if (htmlCommentBlockStartPattern.test(line)) {
      if (!line.includes("-->")) {
        inHtmlCommentBlock = true;
      }
      previousBlank = false;
      visible.push({ index, line, visibleLine: "", hidden: true });
      continue;
    }

    const stripped = stripInlineHtmlComments(line, false);
    inInlineComment = stripped.inComment;
    previousBlank = false;
    visible.push({
      index,
      line,
      visibleLine: stripped.text,
      hidden: false,
    });
  }

  return visible;
};

const isVisibleSectionHeading = (entry) =>
  !entry.hidden &&
  sectionHeadingPattern.test(stripClosingAtxHashes(entry.visibleLine));

const isVisibleAnyHeading = (entry) =>
  !entry.hidden && anyHeadingPattern.test(entry.visibleLine);

export const parsePrBodyE2EFlows = (body) => {
  const text = String(body ?? "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const scanned = scanVisibleLines(lines);
  const headingIndices = [];

  for (const entry of scanned) {
    if (isVisibleSectionHeading(entry)) {
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
    if (isVisibleAnyHeading(entry)) {
      end = index;
      break;
    }
  }

  const tokens = [];

  for (let index = start; index < end; index += 1) {
    const entry = scanned[index];
    if (entry.hidden) {
      // Allow HTML comment blocks inside the section, but reject indented code
      // lines or fenced code blocks inside `## E2E flows`.
      if (
        indentedCodeLinePattern.test(entry.line) &&
        !/^[ \t]*$/.test(entry.line)
      ) {
        return {
          ok: false,
          error: `Invalid indented line in \`## E2E flows\`: "${entry.line.trim()}". Use top-level bullet items like \`- admin\`, \`- all\`, or \`- none\`.`,
        };
      }
      if (fenceOpenPattern.test(entry.line)) {
        return {
          ok: false,
          error:
            "Code blocks are not allowed inside `## E2E flows`. Use top-level bullet items like `- admin`, `- all`, or `- none`.",
        };
      }
      continue;
    }
    const rawLine = entry.visibleLine;
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
  let runningDescription = "";
  let runningTargetUrl = "";
  // Track the newest active/terminal verdict per flow so a newer failure OR an
  // active rerun always invalidates an earlier pass for that flow.
  const decidedFlows = new Set();
  const realPassedFlowIds = [];
  const carriedPassedFlowIds = [];
  const failedFlowIds = [];
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
        runningDescription = String(status.description ?? "");
        runningTargetUrl = String(status.target_url ?? "");
        // Exclude older passes for flows actively being rerun so sync never
        // restores an older pass over an in-flight rerun.
        for (const flow of classified.selected) {
          if (!decidedFlows.has(flow)) {
            decidedFlows.add(flow);
          }
        }
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
          failedFlowIds.push(flow);
        }
      }
    }
  }

  const realPassed = buildFlowSelection(realPassedFlowIds);
  const carriedPassed = buildFlowSelection(carriedPassedFlowIds);
  const failed = buildFlowSelection(failedFlowIds);
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
    failedFlows: failed.selected,
    failedFlowsCsv: failed.flows,
    carriedSourceSha,
    coverageSource,
    runningFlows: running.selected,
    runningFlowsCsv: running.flows,
    runningDescription,
    runningTargetUrl,
    anyPassed: allPassed.selected.length > 0,
  };
};
