import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium } from "@playwright/test";
import { playwrightChromiumAvailable } from "@/shared/testing/playwright-browser";
import { makeUnlimitedPassReviewCapture } from "./unlimited-pass-review";

const chromiumAvailable = await playwrightChromiumAvailable();
let browser: Browser;

beforeAll(async () => {
  if (chromiumAvailable) {
    browser = await chromium.launch({
      args: ["--host-resolver-rules=MAP * ~NOTFOUND", "--no-proxy-server"],
    });
  }
});
afterAll(async () => browser?.close());

const origin = "https://workspace.example.test";
const sandbox = "https://xpaysandbox.nexigroup.com";
const accountPath = "/cs-CZ/account/passes";
const checkoutPath = "/cs-CZ/passes/unlimited";
const hostedPath = "/hpp/nexi/card";

test.skipIf(!chromiumAvailable)(
  "writes review PNGs at both widths only from the expected Workspace and empty sandbox pages",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "unlimited-review-"));
    const original = { height: 720, width: 960 };
    const page = await browser.newPage({ viewport: original });
    try {
      await page.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (url.origin === sandbox && url.pathname === hostedPath) {
          return route.fulfill({
            contentType: "text/html",
            body: '<input aria-label="Card number"><input aria-label="Expiration date"><input aria-label="CVV"><input aria-label="Cardholder name">',
          });
        }
        return route.fulfill({
          contentType: "text/html",
          body: '<main><h1>Unlimited</h1><span data-ph-mask>masked</span><input value="synthetic form value"></main>',
        });
      });

      const review = makeUnlimitedPassReviewCapture({
        accountPath,
        directory,
        locale: "cs-CZ",
        origin,
        timeout: 1_000,
      });
      await page.goto(`${origin}${checkoutPath}`);
      await review.captureWorkspace(page, "choose-default");
      await review.captureWorkspace(page, "account-renewal");
      expect(review.missingShots()).toContain("account-renewal");

      const url = `${sandbox}${hostedPath}`;
      const handoff = {
        checkoutPage: page,
        checkoutPageUrl: `${origin}${checkoutPath}?step=pay`,
        page,
        provider: "nexi" as const,
        url,
      };
      await page.goto(url);
      await page
        .getByRole("textbox", { name: "Cardholder name" })
        .fill("synthetic nonempty value");
      await review.captureNexi(page, handoff, []);
      expect(review.missingShots()).toContain("nexi-handoff");
      expect((await readdir(directory)).sort()).toEqual([
        "unlimited-cs-CZ-choose-default-1280.png",
        "unlimited-cs-CZ-choose-default-390.png",
      ]);

      await page.getByRole("textbox", { name: "Cardholder name" }).clear();
      await review.captureNexi(page, handoff, []);
      expect(review.missingShots()).not.toContain("nexi-handoff");
      expect(page.viewportSize()).toEqual(original);
      for (const width of [390, 1280]) {
        for (const shot of ["choose-default", "nexi-handoff"]) {
          const pixels = await readFile(
            join(directory, `unlimited-cs-CZ-${shot}-${width}.png`)
          );
          expect(pixels.toString("ascii", 12, 16)).toBe("IHDR");
          expect(pixels.readUInt32BE(16)).toBe(width);
        }
      }
    } finally {
      await page.close();
      await rm(directory, { force: true, recursive: true });
    }
  }
);
