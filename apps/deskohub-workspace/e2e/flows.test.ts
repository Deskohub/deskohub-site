import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  classifyE2EStatusDescription,
  diffFlowIds,
  formatE2EStatusDescription,
  isWorkspaceE2ECaseSelected,
  needsWorkspaceE2ECheckoutPreparation,
  parsePrBodyE2EFlows,
  parseWorkspaceE2EFlowsInput,
  resolveWorkspaceE2EFlowSelection,
  selectedWorkspaceE2ECheckoutProjects,
  selectedWorkspaceE2EInstantNavigationPlan,
  summarizeCommitStatuses,
  unionFlowIds,
  workspaceE2ECaseFlowById,
  workspaceE2ECheckoutProjectFlowByName,
  workspaceE2EFlowIds,
  workspaceE2EFlowShortCodes,
  workspaceE2EInstantNavigationSpecFlowByFile,
  workspaceE2EWorkflowFlowIds,
} from "./flows";
import { workspaceE2ECaseIds } from "./playwright-checkout/case-catalog";

describe("Workspace E2E flow catalog", () => {
  test("matches the workflow flow catalog in order and short codes", () => {
    expect([...workspaceE2EFlowIds]).toEqual([...workspaceE2EWorkflowFlowIds]);
    const shortCodes = Object.values(workspaceE2EFlowShortCodes);
    expect(new Set(shortCodes).size).toBe(workspaceE2EFlowIds.length);
  });

  test("maps every checkout case and every instant-navigation spec file to a flow", () => {
    expect(Object.keys(workspaceE2ECaseFlowById).sort()).toEqual(
      [...workspaceE2ECaseIds].sort()
    );

    const instantNavigationFiles = readdirSync(
      resolve(import.meta.dir, "instant-navigation")
    )
      .filter(
        (file) =>
          file.endsWith(".pw.ts") &&
          file !== "administrator-setup.pw.ts" &&
          file !== "administrator-cleanup.pw.ts"
      )
      .sort();
    expect(
      Object.keys(workspaceE2EInstantNavigationSpecFlowByFile).sort()
    ).toEqual(instantNavigationFiles);

    expect(Object.keys(workspaceE2ECheckoutProjectFlowByName).sort()).toEqual([
      "access-code-creation",
      "account-auth",
      "administrator-access",
      "email-campaign-recipient-preview",
    ]);
  });
});

describe("PR description ## E2E flows parser", () => {
  test("accepts valid flow subsets, all, none, comments, backticks, and notes", () => {
    expect(
      parsePrBodyE2EFlows(
        "## Summary\n\nChange\n\n## E2E flows\n<!-- comment -->\n- `email-campaigns`: pass reminders\n* admin\n"
      )
    ).toMatchObject({
      ok: true,
      kind: "subset",
      flows: "admin,email-campaigns",
      selected: ["admin", "email-campaigns"],
      runE2E: true,
      installWebkit: false,
    });

    expect(parsePrBodyE2EFlows("## E2E flows\n- `all`\n")).toMatchObject({
      ok: true,
      kind: "all",
      flows: "all",
      runE2E: true,
      installWebkit: true,
    });

    expect(parsePrBodyE2EFlows("## E2E Flows:\n- none\n")).toMatchObject({
      ok: true,
      kind: "none",
      flows: "none",
      selected: [],
      runE2E: false,
      installWebkit: false,
    });

    // Listing every individual flow normalizes to `all`.
    const everyFlowBody = `## E2E flows\n${workspaceE2EFlowIds.map((id) => `- ${id}`).join("\n")}\n`;
    expect(parsePrBodyE2EFlows(everyFlowBody)).toMatchObject({
      ok: true,
      kind: "all",
      flows: "all",
      installWebkit: true,
    });
  });

  test("ignores fake headings inside fenced and indented code blocks", () => {
    const body = [
      "## Summary",
      "```markdown",
      "## E2E flows",
      "- fake",
      "```",
      "~~~md",
      "## E2E flows",
      "- fake-tilde",
      "~~~",
      "",
      "    ## E2E flows",
      "    - none",
      "",
      "## E2E flows",
      "- `webkit`",
      "## Notes",
      "More text",
    ].join("\n");

    expect(parsePrBodyE2EFlows(body)).toMatchObject({
      ok: true,
      kind: "subset",
      flows: "webkit",
      installWebkit: true,
    });
  });

  test.each([
    ["missing section", "## Summary\nNo flows here"],
    ["level-three heading", "### E2E flows\n- none"],
    [
      "indented code block only",
      "## Summary\n\n    ## E2E flows\n    - none\n",
    ],
    ["indented bullet inside section", "## E2E flows\n    - none\n"],
    ["empty section", "## E2E flows\n\n<!-- only comment -->\n## Next\nText"],
    ["duplicate sections", "## E2E flows\n- admin\n## E2E flows\n- account"],
    ["unknown flow", "## E2E flows\n- checkout-magic"],
    ["mixing all with another flow", "## E2E flows\n- all\n- admin"],
    ["mixing none with another flow", "## E2E flows\n- none\n- admin"],
    ["mixing all and none", "## E2E flows\n- all\n- none"],
    ["non-bullet prose", "## E2E flows\nadmin"],
    ["space typo inside flow name", "## E2E flows\n- checkout cowork"],
  ])("fails closed on %s", (_label, body) => {
    expect(parsePrBodyE2EFlows(body).ok).toBe(false);
  });
});

describe("flow selection planning", () => {
  test("selects only required projects, specs, and checkout preparation", () => {
    const adminOnly = resolveWorkspaceE2EFlowSelection("admin");
    expect(needsWorkspaceE2ECheckoutPreparation(adminOnly)).toBe(false);
    expect(selectedWorkspaceE2ECheckoutProjects(adminOnly)).toEqual([
      "administrator-access",
    ]);
    expect(selectedWorkspaceE2EInstantNavigationPlan(adminOnly)).toEqual({
      projects: ["administration-navigation"],
      navigationSpecs: [],
    });

    const emailOnly = resolveWorkspaceE2EFlowSelection("email-campaigns");
    expect(needsWorkspaceE2ECheckoutPreparation(emailOnly)).toBe(false);
    expect(
      needsWorkspaceE2ECheckoutPreparation(emailOnly, {
        includeNightlyCases: true,
      })
    ).toBe(true);
    expect(selectedWorkspaceE2ECheckoutProjects(emailOnly)).toEqual([
      "email-campaign-recipient-preview",
    ]);
    expect(selectedWorkspaceE2EInstantNavigationPlan(emailOnly)).toEqual({
      projects: [],
      navigationSpecs: [],
    });

    const publicOnly = resolveWorkspaceE2EFlowSelection("public-site");
    expect(needsWorkspaceE2ECheckoutPreparation(publicOnly)).toBe(false);
    expect(selectedWorkspaceE2ECheckoutProjects(publicOnly)).toEqual([
      "checkout-cases",
    ]);
    expect(isWorkspaceE2ECaseSelected("contact-form", publicOnly)).toBe(true);
    expect(
      isWorkspaceE2ECaseSelected("checkout-cowork-basic", publicOnly)
    ).toBe(false);
    expect(selectedWorkspaceE2EInstantNavigationPlan(publicOnly)).toEqual({
      projects: ["navigation"],
      navigationSpecs: [
        "customer-route-fallbacks.pw.ts",
        "public-account-legal.pw.ts",
        "public-navigation.pw.ts",
        "reservation-navigation.pw.ts",
      ],
    });

    const webkitOnly = resolveWorkspaceE2EFlowSelection("webkit");
    expect(selectedWorkspaceE2ECheckoutProjects(webkitOnly)).toEqual([]);
    expect(selectedWorkspaceE2EInstantNavigationPlan(webkitOnly)).toEqual({
      projects: ["navigation", "webkit"],
      navigationSpecs: ["temporal-runtime.pw.ts"],
    });

    const none = resolveWorkspaceE2EFlowSelection("none");
    expect(selectedWorkspaceE2ECheckoutProjects(none)).toEqual([]);
    expect(selectedWorkspaceE2EInstantNavigationPlan(none)).toEqual({
      projects: [],
      navigationSpecs: [],
    });
  });

  test("rejects malformed comma-separated inputs", () => {
    expect(parseWorkspaceE2EFlowsInput("").ok).toBe(false);
    expect(parseWorkspaceE2EFlowsInput("admin,").ok).toBe(false);
    expect(parseWorkspaceE2EFlowsInput("all,admin").ok).toBe(false);
    expect(parseWorkspaceE2EFlowsInput("bogus").ok).toBe(false);
  });
});

describe("commit status description encoding and coverage summary", () => {
  test("stays within GitHub's 140-char limit and round-trips every subset size", () => {
    const sha = "a".repeat(40);
    const largeSubset = workspaceE2EFlowIds.slice(0, 12).join(",");

    for (const flows of [
      "all",
      "admin",
      "admin,email-campaigns",
      largeSubset,
    ]) {
      for (const kind of [
        "passed",
        "partial",
        "running",
        "failed",
        "same-tree-passed",
      ] as const) {
        const description = formatE2EStatusDescription({
          kind,
          flows,
          sourceSha: sha,
        });
        expect(description.length).toBeLessThanOrEqual(140);
        const classified = classifyE2EStatusDescription(description);
        expect(classified.kind).toBe(
          kind === "same-tree-passed" ? "carried-passed" : kind
        );
        if (classified.kind !== "other" && classified.kind !== "superseded") {
          const expected =
            flows === "all" ? [...workspaceE2EFlowIds] : flows.split(",");
          expect([...classified.selected]).toEqual(expected);
        }
      }
    }

    const skipped = formatE2EStatusDescription({ kind: "skipped-none" });
    expect(skipped.length).toBeLessThanOrEqual(140);
    expect(classifyE2EStatusDescription(skipped)).toEqual({
      kind: "skipped-none",
      selected: [],
    });
  });

  test("unions passed flows across runs, tracks in-flight flows, and lets a newer failure override an older pass", () => {
    const summary = summarizeCommitStatuses([
      {
        context: "Workspace E2E",
        creator: { login: "github-actions[bot]" },
        description:
          "Protected preview E2E is running [flows: email-campaigns]",
        state: "pending",
      },
      {
        context: "Workspace E2E",
        creator: { login: "github-actions[bot]" },
        description: "Protected preview E2E passed [flows: admin]",
        state: "success",
      },
    ]);

    expect(summary.latestRunKind).toBe("running");
    expect(summary.passedFlows).toEqual(["admin"]);
    expect(summary.runningFlows).toEqual(["email-campaigns"]);
    expect(
      diffFlowIds(["admin", "email-campaigns"], summary.passedFlows)
    ).toEqual(["email-campaigns"]);
    expect(unionFlowIds(summary.passedFlows, summary.runningFlows)).toEqual([
      "admin",
      "email-campaigns",
    ]);

    const afterFailure = summarizeCommitStatuses([
      {
        context: "Workspace E2E",
        creator: { login: "github-actions[bot]" },
        description: "Protected preview E2E failed [flows: admin]",
        state: "failure",
      },
      {
        context: "Workspace E2E",
        creator: { login: "github-actions[bot]" },
        description:
          "Protected preview E2E passed [flows: admin,email-campaigns]",
        state: "success",
      },
    ]);
    expect(afterFailure.latestRunState).toBe("failure");
    expect(afterFailure.passedFlows).toEqual(["email-campaigns"]);
    expect(afterFailure.realPassedFlows).toEqual(["email-campaigns"]);

    const partialAndCarried = summarizeCommitStatuses(
      [
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description:
            "Protected preview E2E partial; more flows required [flows: admin]",
          state: "failure",
        },
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description:
            "Same tree as bbbbbbb, which passed E2E [flows: email-campaigns]",
          state: "success",
        },
      ],
      { includeCarried: true }
    );
    expect(partialAndCarried.realPassedFlows).toEqual(["admin"]);
    expect(partialAndCarried.carriedPassedFlows).toEqual(["email-campaigns"]);
    expect(partialAndCarried.carriedSourceSha).toBe("bbbbbbb");
    expect(partialAndCarried.passedFlows).toEqual(["admin", "email-campaigns"]);
  });
});
