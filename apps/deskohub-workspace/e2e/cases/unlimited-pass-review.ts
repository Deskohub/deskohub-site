import { link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Frame, Locator, Page } from "@playwright/test";
import { getLegalDocumentPath } from "@/features/legal/legal-document-path";
import { unlimitedPassCheckoutPath } from "@/features/passes/routes";
import { locateSnapshotRef } from "../browser";
import {
  findNexiCardField,
  type NexiCardField,
  parseNexiSnapshot,
} from "../checkout/nexi-hosted-page";
import { observeNexiReviewNavigation } from "../checkout/nexi-review-navigation";
import type { HostedPaymentPage } from "../checkout/payment";
import type { unlimitedPassReviewLocale } from "../e2e-env";
import { log, workspaceDir } from "../runtime";
import { workspaceE2EPollIntervalMs } from "../timeouts";

type ReviewLocale = NonNullable<ReturnType<typeof unlimitedPassReviewLocale>>;
type SyntheticReviewBuyer = {
  readonly email: string;
  readonly name: string;
};

const workspaceShots = [
  "choose-default",
  "choose-renewal",
  "details",
  "pay-unchecked",
  "pay-accepted",
  "paid-status",
  "account-renewal",
  "account-stop-confirmed",
  "account-stopped-after-reload",
  "manual-renew",
  "terms",
] as const;
type WorkspaceShot = (typeof workspaceShots)[number];
type ReviewShot = WorkspaceShot | "nexi-handoff";
type CardFieldProblem =
  | "snapshot-unavailable"
  | "card-field-missing"
  | "card-field-unreadable"
  | "card-field-populated";
type PopulatedCardFieldDetails = {
  readonly autofilled: boolean;
  readonly matchesDefaultValue: boolean;
  readonly matchesPlaceholder: boolean;
};
type CardFieldObservation = { readonly role: NexiCardField } & (
  | { readonly state: "empty" | "missing" | "unreadable" }
  | {
      readonly state: "populated";
      readonly details: PopulatedCardFieldDetails | "unavailable";
      readonly matchesSyntheticBuyer?: boolean;
    }
);
type CardFieldInspection = {
  readonly problem?: CardFieldProblem;
  readonly fields: readonly CardFieldObservation[];
};
type CaptureProblem =
  | CardFieldProblem
  | "viewport-unavailable"
  | "viewport-change-failed"
  | "viewport-restore-failed"
  | "untracked-document"
  | "unexpected-document"
  | "document-navigated"
  | "screenshot-failed"
  | "write-failed";

type ReviewImage = {
  readonly filename: string;
  readonly pixels: Buffer;
};

const viewports = [
  { height: 844, width: 390 },
  { height: 900, width: 1280 },
] as const;

const requiredCardFields = [
  "card_number",
  "expiration_date",
  "security_code",
] as const;
const optionalCardFields = ["cardholder_name", "cardholder_email"] as const;
const sandboxOrigin = "https://xpaysandbox.nexigroup.com";

async function describePopulatedCardField(
  input: Locator,
  deadline: number
): Promise<PopulatedCardFieldDetails | "unavailable"> {
  const timeout = Math.min(
    deadline - performance.now(),
    workspaceE2EPollIntervalMs.browser
  );
  if (timeout <= 0) return "unavailable";
  const details = await input
    .evaluate(
      (element) => {
        if (
          !(element instanceof HTMLInputElement) &&
          !(element instanceof HTMLTextAreaElement)
        ) {
          return;
        }
        const { value } = element;
        if (value === "") return;
        return {
          autofilled: element.matches(":autofill") === true,
          matchesDefaultValue: value === element.defaultValue,
          matchesPlaceholder: value === element.placeholder,
        };
      },
      undefined,
      { timeout }
    )
    .catch(() => undefined);
  return details ?? "unavailable";
}

async function inspectCardFields(
  page: Page,
  deadline: number,
  buyer: SyntheticReviewBuyer | undefined
): Promise<CardFieldInspection> {
  const snapshotTimeout = deadline - performance.now();
  if (snapshotTimeout <= 0)
    return { problem: "snapshot-unavailable", fields: [] };
  const body = await page
    .locator("body")
    .ariaSnapshot({ mode: "ai", timeout: snapshotTimeout })
    .catch(() => undefined);
  if (!body) return { problem: "snapshot-unavailable", fields: [] };
  const snapshot = parseNexiSnapshot(body);
  const fields: CardFieldObservation[] = [];
  for (const field of [...requiredCardFields, ...optionalCardFields]) {
    const target = findNexiCardField(snapshot, field);
    if (!target) {
      fields.push({ role: field, state: "missing" });
      if (field === "cardholder_name" || field === "cardholder_email") continue;
      return { problem: "card-field-missing", fields };
    }
    const input = (
      target.frameRef
        ? locateSnapshotRef(page, target.frameRef)
            .filter({ visible: true })
            .contentFrame()
            .locator("input")
        : locateSnapshotRef(page, target.ref)
    ).filter({ visible: true });
    const timeout = Math.min(
      deadline - performance.now(),
      workspaceE2EPollIntervalMs.browser
    );
    const value =
      timeout > 0
        ? await input.inputValue({ timeout }).catch(() => undefined)
        : undefined;
    if (value === undefined) {
      fields.push({ role: field, state: "unreadable" });
      return { problem: "card-field-unreadable", fields };
    }
    if (value !== "") {
      // A failed or changed diagnostic sample cannot overturn the refusal.
      const details = await describePopulatedCardField(input, deadline);
      let expectedBuyerField: string | undefined;
      if (field === "cardholder_name") expectedBuyerField = buyer?.name;
      if (field === "cardholder_email") expectedBuyerField = buyer?.email;
      fields.push({
        role: field,
        state: "populated",
        details,
        ...(expectedBuyerField !== undefined && {
          matchesSyntheticBuyer: value === expectedBuyerField,
        }),
      });
      return { problem: "card-field-populated", fields };
    }
    fields.push({ role: field, state: "empty" });
  }
  return { fields };
}

async function waitForEmptyCardFields(
  page: Page,
  timeout: number,
  buyer: SyntheticReviewBuyer | undefined
) {
  const deadline = performance.now() + timeout;
  while (true) {
    const nextRead = performance.now() + workspaceE2EPollIntervalMs.browser;
    const inspection = await inspectCardFields(page, deadline, buyer);
    if (!inspection.problem || inspection.problem === "card-field-populated") {
      return inspection;
    }
    const now = performance.now();
    const remaining = deadline - now;
    if (remaining <= 0) return inspection;
    const wait = Math.min(remaining, nextRead - now);
    if (wait > 0) await delay(wait);
    if (performance.now() >= deadline) return inspection;
  }
}

async function writeReviewImages(
  directory: string,
  images: readonly ReviewImage[]
) {
  await mkdir(directory, { recursive: true });
  const staging = await mkdtemp(resolve(directory, ".unlimited-review-"));
  const published: string[] = [];
  try {
    for (const { filename, pixels } of images) {
      await writeFile(resolve(staging, filename), pixels);
    }
    for (const { filename } of images) {
      const destination = resolve(directory, filename);
      await link(resolve(staging, filename), destination);
      published.push(destination);
    }
  } catch (cause) {
    await Promise.allSettled(
      published.map((path) => rm(path, { force: true }))
    );
    throw cause;
  } finally {
    await rm(staging, { force: true, recursive: true });
  }
}

export function makeUnlimitedPassReviewCapture({
  accountPath,
  directory = resolve(workspaceDir, "e2e-artifacts", "account-review"),
  locale,
  origin,
  timeout,
}: {
  readonly accountPath: string;
  readonly directory?: string;
  readonly locale: ReviewLocale;
  readonly origin: string;
  readonly timeout: number;
}) {
  const results = new Map<ReviewShot, CaptureProblem | "captured">();
  const checkoutPath = `/${locale}${unlimitedPassCheckoutPath}`;
  const termsPath = getLegalDocumentPath(locale, "terms-and-conditions");

  // A failing screenshot can leave the review incomplete, but it must not
  // interrupt a payable Nexi attempt before the normal journal settles it.
  async function capture(
    page: Page,
    shot: ReviewShot,
    options: {
      readonly verify: () => Promise<CaptureProblem | undefined>;
      readonly mask: readonly Locator[];
      readonly section?: Locator;
      readonly style?: string;
      readonly verifyDocument?: () => Promise<boolean>;
    }
  ) {
    if (results.get(shot) === "captured") return;
    let phase: CaptureProblem = "viewport-unavailable";
    try {
      const original = page.viewportSize();
      if (!original) return;
      const originalUrl = page.url();
      const mainFrame = page.mainFrame();
      const images: ReviewImage[] = [];
      let navigated = false;
      let restored = false;
      const recordNavigation = (frame: Frame) => {
        if (
          frame === mainFrame &&
          (!options.verifyDocument || frame.url() !== originalUrl)
        )
          navigated = true;
      };
      const navigationObserved = () => navigated || page.url() !== originalUrl;
      const documentChanged = async () =>
        navigationObserved() ||
        (options.verifyDocument !== undefined &&
          (!(await options.verifyDocument()) || navigationObserved()));
      page.on("framenavigated", recordNavigation);
      try {
        for (const viewport of viewports) {
          phase = "viewport-change-failed";
          await page.setViewportSize(viewport);
          phase = "unexpected-document";
          const problem = await options.verify();
          if (navigationObserved()) {
            phase = "document-navigated";
            return;
          }
          if (problem) {
            phase = problem;
            return;
          }
          if (await documentChanged()) {
            phase = "document-navigated";
            return;
          }
          const mask = [...options.mask];
          const screenshot = {
            animations: "disabled",
            mask,
            scale: "css",
            ...(options.style && { style: options.style }),
            timeout,
            type: "png",
          } as const;
          phase = "screenshot-failed";
          const pixels = options.section
            ? await options.section.screenshot(screenshot)
            : await page.screenshot({
                ...screenshot,
                fullPage: shot !== "nexi-handoff",
              });
          if (await documentChanged()) {
            phase = "document-navigated";
            return;
          }
          images.push({
            filename: `unlimited-${locale}-${shot}-${viewport.width}.png`,
            pixels,
          });
        }
      } finally {
        page.off("framenavigated", recordNavigation);
        try {
          await page.setViewportSize(original);
          restored = true;
        } catch {
          if (images.length === viewports.length)
            phase = "viewport-restore-failed";
        }
      }
      if (!restored) return;
      phase = "write-failed";
      await writeReviewImages(directory, images);
      results.set(shot, "captured");
    } catch {
      // Playwright and filesystem errors can contain private values.
    } finally {
      if (results.get(shot) !== "captured") results.set(shot, phase);
    }
  }

  return {
    captureWorkspace: (
      page: Page,
      shot: WorkspaceShot,
      privateText: readonly string[] = [],
      orderId?: string
    ) => {
      let path = checkoutPath;
      if (shot === "terms") path = termsPath;
      else if (shot === "paid-status")
        path = `/${locale}/reservation/status/${orderId}`;
      else if (shot.startsWith("account-")) path = accountPath;
      return capture(page, shot, {
        mask: [
          page.locator(
            "[data-ph-mask], input:not([type=checkbox], [type=radio]), textarea"
          ),
          ...privateText.map((value) => page.getByText(value, { exact: true })),
        ],
        ...(shot === "terms" && {
          section: page
            .getByRole("heading", { level: 2, name: /^16\./ })
            .locator("xpath=ancestor::section[1]"),
        }),
        verify: async () => {
          const url = URL.parse(page.url());
          if (url?.origin !== origin || url.pathname !== path)
            return "unexpected-document";
        },
      });
    },
    captureNexi: async (
      page: Page,
      hosted: HostedPaymentPage,
      privateText: readonly string[],
      buyer?: SyntheticReviewBuyer
    ) => {
      if (results.get("nexi-handoff") === "captured") return;
      // Share the existing two-width inspection budget. The first view may
      // spend most of it waiting for Nexi to render its hosted fields.
      let inspectionBudget = viewports.length * timeout;
      let fieldInspection: CardFieldInspection | undefined;
      const { isHandoffDocument } = hosted;
      const verifyDocument = () =>
        isHandoffDocument?.(page, timeout) ?? Promise.resolve(false);
      const matchesHostedPage =
        page === hosted.page &&
        hosted.provider === "nexi" &&
        URL.parse(page.url())?.origin === sandboxOrigin;
      const observation = matchesHostedPage
        ? observeNexiReviewNavigation(page)
        : undefined;
      try {
        if (!isHandoffDocument) {
          results.set("nexi-handoff", "untracked-document");
          return;
        }
        const started = performance.now();
        if (!matchesHostedPage || !(await verifyDocument())) {
          results.set("nexi-handoff", "unexpected-document");
          return;
        }
        inspectionBudget -= performance.now() - started;
        await capture(page, "nexi-handoff", {
          mask: [
            page.locator("[data-ph-mask]"),
            ...privateText.map((value) =>
              page.getByText(value, { exact: true })
            ),
          ],
          // Preserve the empty field outlines even if the provider changes the
          // form between the live value check and the screenshot.
          style:
            "input:not([type=submit], [type=button], [type=checkbox], [type=radio]), textarea { color: transparent !important; caret-color: transparent !important; }",
          verifyDocument,
          verify: async () => {
            if (!(await verifyDocument())) return "unexpected-document";
            const started = performance.now();
            fieldInspection = await waitForEmptyCardFields(
              page,
              inspectionBudget,
              buyer
            );
            inspectionBudget -= performance.now() - started;
            return fieldInspection.problem;
          },
        });
      } finally {
        const lifecycle = observation?.finish();
        const result = results.get("nexi-handoff");
        if (lifecycle && result && result !== "captured") {
          log(
            `NEXI REVIEW DOCUMENT ${JSON.stringify({ result, ...lifecycle })}`
          );
          if (fieldInspection?.problem === result) {
            log(`NEXI REVIEW CARD FIELDS ${JSON.stringify(fieldInspection)}`);
          }
        }
      }
    },
    missingShots: (
      required: readonly ReviewShot[] = [...workspaceShots, "nexi-handoff"]
    ) =>
      required.flatMap((shot) => {
        const result = results.get(shot);
        return result === "captured"
          ? []
          : [{ shot, problem: result ?? "not-attempted" }];
      }),
  };
}
