import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { getLegalDocumentPath } from "@/features/legal/legal-document-path";
import { unlimitedPassCheckoutPath } from "@/features/passes/routes";
import { locateSnapshotRef } from "../browser";
import {
  findNexiCardField,
  parseNexiSnapshot,
} from "../checkout/nexi-hosted-page";
import type { HostedPaymentPage } from "../checkout/payment";
import type { unlimitedPassReviewLocale } from "../e2e-env";
import { workspaceDir } from "../runtime";

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

async function hasEmptyCardFields(page: Page, timeout: number) {
  const snapshot = parseNexiSnapshot(
    await page.locator("body").ariaSnapshot({ mode: "ai", timeout })
  );
  for (const field of [...requiredCardFields, ...optionalCardFields]) {
    const target = findNexiCardField(snapshot, field);
    if (!target) {
      if (field === "cardholder_name" || field === "cardholder_email") continue;
      return false;
    }
    const input = (
      target.frameRef
        ? locateSnapshotRef(page, target.frameRef)
            .filter({ visible: true })
            .contentFrame()
            .locator("input")
        : locateSnapshotRef(page, target.ref)
    ).filter({ visible: true });
    if ((await input.inputValue({ timeout })) !== "") return false;
  }
  return true;
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
  const captured = new Set<ReviewShot>();
  const checkoutPath = `/${locale}${unlimitedPassCheckoutPath}`;
  const termsPath = getLegalDocumentPath(locale, "terms-and-conditions");

  // A failing screenshot can leave the review incomplete, but it must not
  // interrupt a payable Nexi attempt before the normal journal settles it.
  async function capture(
    page: Page,
    shot: ReviewShot,
    options: {
      readonly verify: () => Promise<boolean>;
      readonly mask: readonly Locator[];
      readonly section?: Locator;
      readonly style?: string;
    }
  ) {
    try {
      const original = page.viewportSize();
      if (!original)
        throw new Error("Review capture requires a fixed viewport");
      await mkdir(directory, { recursive: true });
      try {
        for (const viewport of viewports) {
          await page.setViewportSize(viewport);
          if (!(await options.verify()))
            throw new Error("Unexpected review document");
          const mask = [...options.mask];
          const screenshot = {
            animations: "disabled",
            mask,
            path: resolve(
              directory,
              `unlimited-${locale}-${shot}-${viewport.width}.png`
            ),
            scale: "css",
            ...(options.style && { style: options.style }),
            timeout,
            type: "png",
          } as const;
          if (options.section) await options.section.screenshot(screenshot);
          else
            await page.screenshot({
              ...screenshot,
              fullPage: shot !== "nexi-handoff",
            });
        }
      } finally {
        await page.setViewportSize(original);
      }
      captured.add(shot);
    } catch {
      // The final review step reports missing stages without browser details.
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
          section: page.locator("section").filter({
            has: page.getByRole("heading", { level: 2, name: /^16\./ }),
          }),
        }),
        verify: async () => {
          const url = URL.parse(page.url());
          return url?.origin === origin && url.pathname === path;
        },
      });
    },
    captureNexi: (
      page: Page,
      hosted: HostedPaymentPage,
      privateText: readonly string[]
    ) =>
      capture(page, "nexi-handoff", {
        mask: [
          page.locator("[data-ph-mask]"),
          ...privateText.map((value) => page.getByText(value, { exact: true })),
        ],
        // Preserve the empty field outlines even if the provider changes the
        // form between the live value check and the screenshot.
        style:
          "input:not([type=submit], [type=button], [type=checkbox], [type=radio]), textarea { color: transparent !important; caret-color: transparent !important; }",
        verify: async () => {
          const url = URL.parse(page.url());
          if (
            page !== hosted.page ||
            hosted.provider !== "nexi" ||
            url?.origin !== sandboxOrigin ||
            url.href !== hosted.url
          )
            return false;
          await expect
            .poll(() => hasEmptyCardFields(page, timeout), { timeout })
            .toBe(true);
          return page.url() === hosted.url;
        },
      }),
    missingShots: () =>
      [...workspaceShots, "nexi-handoff" as const].filter(
        (shot) => !captured.has(shot)
      ),
  };
}
