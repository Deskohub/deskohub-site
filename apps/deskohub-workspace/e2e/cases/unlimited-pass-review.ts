import { link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Frame, JSHandle, Locator, Page } from "@playwright/test";
import { getLegalDocumentPath } from "@/features/legal/legal-document-path";
import { unlimitedPassCheckoutPath } from "@/features/passes/routes";
import type { NexiCardField } from "../checkout/nexi-hosted-page";
import { observeNexiReviewNavigation } from "../checkout/nexi-review-navigation";
import type { HostedPaymentPage } from "../checkout/payment";
import type { unlimitedPassReviewLocale } from "../e2e-env";
import { log, workspaceDir } from "../runtime";
import { workspaceE2EPollIntervalMs } from "../timeouts";

type ReviewLocale = NonNullable<ReturnType<typeof unlimitedPassReviewLocale>>;

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
  | "card-field-unreadable"
  | "card-field-populated"
  | "identity-mask-unavailable";
type PopulatedCardFieldDetails = {
  readonly autofilled: boolean;
  readonly matchesDefaultValue: boolean;
  readonly matchesPlaceholder: boolean;
};
type CardFieldObservation = { readonly role: NexiCardField } & (
  | { readonly state: "empty" | "unreadable" }
  | {
      readonly state: "populated";
      readonly details: PopulatedCardFieldDetails | "unavailable";
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
  | "card-controls-changed"
  | "identity-mask-changed"
  | "identity-mask-not-rendered"
  | "screenshot-failed"
  | "write-failed";

type ReviewImage = {
  readonly filename: string;
  readonly pixels: Buffer;
};
type IdentityMasks = readonly [Locator, Locator];
type MaskRectangle = NonNullable<Awaited<ReturnType<Locator["boundingBox"]>>>;
type CardInputBinding = JSHandle<
  | {
      readonly remainsEmpty: (candidate: Element) => boolean;
      readonly disconnect: () => void;
    }
  | undefined
>;
type CaptureVerification =
  | CaptureProblem
  | {
      readonly cardInputs: readonly Locator[];
      readonly identityMasks: IdentityMasks;
      readonly frameRevision: number;
    }
  | undefined;

const viewports = [
  { height: 844, width: 390 },
  { height: 900, width: 1280 },
] as const;

const requiredCardFields = [
  "card_number",
  "expiration_date",
  "security_code",
] as const;
// Nexi's card-data form assigns each hosted iframe the title of its field ID.
const nexiFieldFrameTitles = {
  card_number: "CARD_NUMBER",
  expiration_date: "EXPIRATION_DATE",
  security_code: "SECURITY_CODE",
  cardholder_name: "CARDHOLDER_NAME",
  cardholder_email: "CARDHOLDER_EMAIL",
} as const satisfies Record<NexiCardField, string>;
const sandboxOrigin = "https://xpaysandbox.nexigroup.com";
const identityMaskColor = "#ff00ff";

const nexiFieldFrame = (page: Page, role: NexiCardField) =>
  page.locator(`iframe[title="${nexiFieldFrameTitles[role]}"]`).filter({
    visible: true,
  });

const nexiFrameInput = (frame: Locator) =>
  frame.contentFrame().locator("input").filter({ visible: true });

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
  identityMasks: IdentityMasks
): Promise<CardFieldInspection> {
  const fields: CardFieldObservation[] = [];
  for (const field of requiredCardFields) {
    const input = nexiFrameInput(nexiFieldFrame(page, field));
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
      fields.push({ role: field, state: "populated", details });
      return { problem: "card-field-populated", fields };
    }
    fields.push({ role: field, state: "empty" });
  }
  for (const [index, frame] of identityMasks.entries()) {
    const timeout = Math.min(
      deadline - performance.now(),
      workspaceE2EPollIntervalMs.browser
    );
    const visible =
      timeout > 0 &&
      (await nexiFrameInput(frame)
        .waitFor({ state: "visible", timeout })
        .then(
          () => true,
          () => false
        ));
    if (!visible) {
      const role = index === 0 ? "cardholder_name" : "cardholder_email";
      fields.push({ role, state: "unreadable" });
      return { problem: "identity-mask-unavailable", fields };
    }
  }
  return { fields };
}

async function waitForEmptyCardFields(
  page: Page,
  timeout: number,
  identityMasks: IdentityMasks,
  frameRevision: () => number
) {
  const deadline = performance.now() + timeout;
  while (true) {
    const nextRead = performance.now() + workspaceE2EPollIntervalMs.browser;
    const revision = frameRevision();
    const inspection = await inspectCardFields(page, deadline, identityMasks);
    if (inspection.problem === "card-field-populated") return { inspection };
    if (!inspection.problem && revision === frameRevision()) {
      return { inspection, revision };
    }
    const now = performance.now();
    const remaining = deadline - now;
    if (remaining <= 0) return { inspection };
    const wait = Math.min(remaining, nextRead - now);
    if (wait > 0) await delay(wait);
    if (performance.now() >= deadline) return { inspection };
  }
}

async function bindCardInput(
  input: Locator,
  timeout: number
): Promise<CardInputBinding | undefined> {
  const pending = input
    .evaluateHandle((element) => {
      if (!(element instanceof HTMLInputElement)) return;
      const removedInput = (records: readonly MutationRecord[]) =>
        records.some((record) =>
          Array.from(record.removedNodes).some((node) => node.contains(element))
        );
      let removed = false;
      const observer = new MutationObserver((records) => {
        removed ||= removedInput(records);
      });
      observer.observe(element.ownerDocument, {
        childList: true,
        subtree: true,
      });
      return {
        disconnect: () => observer.disconnect(),
        remainsEmpty: (candidate: Element) =>
          candidate === element &&
          element.isConnected &&
          !(removed || removedInput(observer.takeRecords())) &&
          element.value === "",
      };
    })
    .catch(() => undefined);
  const binding = await Promise.race([
    pending,
    delay(timeout, undefined, { ref: false }),
  ]);
  if (!binding) void pending.then((late) => releaseCardInput(late, timeout));
  return binding;
}

async function cardInputsRemainEmpty(
  inputs: readonly Locator[],
  bindings: readonly (CardInputBinding | undefined)[],
  timeout: number
) {
  const checks = await Promise.all(
    inputs.map((input, index) => {
      const binding = bindings[index];
      return (
        binding &&
        input
          .evaluate(
            (element, guard) => guard?.remainsEmpty(element) === true,
            binding,
            { timeout }
          )
          .catch(() => false)
      );
    })
  );
  return checks.every((passed) => passed === true);
}

async function releaseCardInput(
  binding: CardInputBinding | undefined,
  timeout: number
) {
  if (!binding) return;
  const release = async () => {
    await binding
      .evaluate((guard) => guard?.disconnect())
      .catch(() => undefined);
    await binding.dispose().catch(() => undefined);
  };
  await Promise.race([release(), delay(timeout, undefined, { ref: false })]);
}

async function identityMaskRectangles(
  masks: IdentityMasks,
  timeout: number
): Promise<readonly MaskRectangle[] | undefined> {
  const boxes = await Promise.all(
    masks.map((mask) => mask.boundingBox({ timeout }).catch(() => null))
  );
  if (boxes.some((box) => box === null)) return;
  return boxes.filter((box) => box !== null);
}

const sameMaskRectangles = (
  before: readonly MaskRectangle[],
  after: readonly MaskRectangle[]
) =>
  before.length === after.length &&
  before.every((box, index) => {
    const other = after[index];
    return (
      box.x === other?.x &&
      box.y === other.y &&
      box.width === other.width &&
      box.height === other.height
    );
  });

async function identityMasksRendered(
  pixels: Buffer,
  boxes: readonly MaskRectangle[]
): Promise<boolean> {
  const { default: sharp } = await import("sharp");
  const { data, info } = await sharp(pixels)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) return false;
  return boxes.every((box) => {
    const left = Math.max(0, Math.ceil(box.x));
    const top = Math.max(0, Math.ceil(box.y));
    const right = Math.min(info.width, Math.floor(box.x + box.width));
    const bottom = Math.min(info.height, Math.floor(box.y + box.height));
    if (left >= right || top >= bottom) return false;
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        const index = (y * info.width + x) * info.channels;
        if (
          data[index] !== 255 ||
          data[index + 1] !== 0 ||
          data[index + 2] !== 255 ||
          data[index + 3] !== 255
        ) {
          return false;
        }
      }
    }
    return true;
  });
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
      readonly verify: (
        frameRevision: () => number
      ) => Promise<CaptureVerification>;
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
      let frameRevision = 0;
      let boundFrameRevision: number | undefined;
      let cardBindings: readonly (CardInputBinding | undefined)[] | undefined;
      const recordFrameChange = (frame: Frame) => {
        if (frame !== mainFrame) frameRevision++;
      };
      const recordNavigation = (frame: Frame) => {
        recordFrameChange(frame);
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
      if (shot === "nexi-handoff") {
        page.on("frameattached", recordFrameChange);
        page.on("framedetached", recordFrameChange);
      }
      try {
        for (const viewport of viewports) {
          phase = "viewport-change-failed";
          await page.setViewportSize(viewport);
          phase = "unexpected-document";
          const verification = await options.verify(() => frameRevision);
          if (navigationObserved()) {
            phase = "document-navigated";
            return;
          }
          if (typeof verification === "string") {
            phase = verification;
            return;
          }
          if (await documentChanged()) {
            phase = "document-navigated";
            return;
          }
          const mask = [...options.mask];
          const identityMasks = verification?.identityMasks;
          let identityBoxes: readonly MaskRectangle[] | undefined;
          const maskTimeout = Math.min(
            timeout,
            workspaceE2EPollIntervalMs.browser
          );
          if (verification) {
            boundFrameRevision ??= verification.frameRevision;
            phase = "identity-mask-changed";
            if (
              frameRevision !== boundFrameRevision ||
              frameRevision !== verification.frameRevision
            )
              return;
            cardBindings ??= await Promise.all(
              verification.cardInputs.map((input) =>
                bindCardInput(input, maskTimeout)
              )
            );
            phase = "card-controls-changed";
            if (
              !(await cardInputsRemainEmpty(
                verification.cardInputs,
                cardBindings,
                maskTimeout
              ))
            )
              return;
            phase = "identity-mask-unavailable";
            identityBoxes = await identityMaskRectangles(
              verification.identityMasks,
              maskTimeout
            );
            if (!identityBoxes) return;
            mask.push(...verification.identityMasks);
            phase = "identity-mask-changed";
            if (frameRevision !== boundFrameRevision) return;
          }
          const screenshot = {
            animations: "disabled",
            mask,
            ...(identityMasks && { maskColor: identityMaskColor }),
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
          if (verification && identityBoxes && cardBindings) {
            phase = "identity-mask-changed";
            const after = await identityMaskRectangles(
              verification.identityMasks,
              maskTimeout
            );
            if (
              !after ||
              frameRevision !== boundFrameRevision ||
              !sameMaskRectangles(identityBoxes, after)
            )
              return;
            phase = "card-controls-changed";
            if (
              !(await cardInputsRemainEmpty(
                verification.cardInputs,
                cardBindings,
                maskTimeout
              ))
            )
              return;
            phase = "identity-mask-not-rendered";
            if (!(await identityMasksRendered(pixels, identityBoxes))) return;
            if (await documentChanged()) {
              phase = "document-navigated";
              return;
            }
            phase = "identity-mask-changed";
            if (frameRevision !== boundFrameRevision) return;
          }
          images.push({
            filename: `unlimited-${locale}-${shot}-${viewport.width}.png`,
            pixels,
          });
        }
      } finally {
        page.off("framenavigated", recordNavigation);
        if (shot === "nexi-handoff") {
          page.off("frameattached", recordFrameChange);
          page.off("framedetached", recordFrameChange);
        }
        if (cardBindings) {
          await Promise.all(
            cardBindings.map((binding) =>
              releaseCardInput(
                binding,
                Math.min(timeout, workspaceE2EPollIntervalMs.browser)
              )
            )
          );
        }
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
            "[data-ph-mask], input:not([type=checkbox], [type=radio], [name=discountCode]), textarea"
          ),
          ...privateText.map((value) => page.getByText(value, { exact: true })),
        ],
        // Full-page captures include the offscreen skip link and place a fixed
        // header at the current viewport offset. Keep the header at the top of
        // the chooser, and redact any typed code without painting its field.
        style: `
          a[href="#main-content"]:not(:focus-visible) { visibility: hidden; }
          input[name="discountCode"] {
            -webkit-text-fill-color: transparent;
            caret-color: transparent;
          }
          ${shot === "choose-renewal" ? "header.fixed { position: absolute; }" : ""}
        `,
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
      privateText: readonly string[]
    ) => {
      if (results.get("nexi-handoff") === "captured") return;
      // Share the existing two-width inspection budget. The first view may
      // spend most of it waiting for Nexi to render its hosted fields.
      let inspectionBudget = viewports.length * timeout;
      let fieldInspection: CardFieldInspection | undefined;
      const identityMasks: IdentityMasks = [
        nexiFieldFrame(page, "cardholder_name"),
        nexiFieldFrame(page, "cardholder_email"),
      ];
      const cardInputs = requiredCardFields.map((role) =>
        nexiFrameInput(nexiFieldFrame(page, role))
      );
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
            "input:not([type=submit], [type=button], [type=checkbox], [type=radio]), textarea { color: transparent !important; -webkit-text-fill-color: transparent !important; caret-color: transparent !important; text-shadow: none !important; }",
          verifyDocument,
          verify: async (frameRevision) => {
            if (!(await verifyDocument())) return "unexpected-document";
            const started = performance.now();
            const { inspection, revision } = await waitForEmptyCardFields(
              page,
              inspectionBudget,
              identityMasks,
              frameRevision
            );
            fieldInspection = inspection;
            inspectionBudget -= performance.now() - started;
            if (inspection.problem) return inspection.problem;
            if (revision === undefined) return "identity-mask-changed";
            return { cardInputs, identityMasks, frameRevision: revision };
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
