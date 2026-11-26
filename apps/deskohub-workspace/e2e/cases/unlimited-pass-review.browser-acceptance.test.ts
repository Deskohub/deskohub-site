import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
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
  "publishes neither width when a review page navigates away and returns during capture",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "unlimited-review-"));
    const page = await browser.newPage();
    try {
      const expectedUrl = `${origin}${checkoutPath}`;
      const unrelatedUrl = "https://unrelated.example.test/account";
      await page.route("**/*", (route) =>
        route.fulfill({
          contentType: "text/html",
          body:
            route.request().url() === unrelatedUrl
              ? "<h1>Unrelated account</h1>"
              : "<h1>Unlimited</h1>",
        })
      );
      await page.goto(expectedUrl);

      const screenshot = page.screenshot.bind(page);
      const captureWithNavigation = spyOn(page, "screenshot")
        .mockImplementationOnce(screenshot)
        .mockImplementationOnce(async (options) => {
          await page.goto(unrelatedUrl);
          const pixels = await screenshot(options);
          await page.goto(expectedUrl);
          return pixels;
        });
      try {
        const review = makeUnlimitedPassReviewCapture({
          accountPath,
          directory,
          locale: "cs-CZ",
          origin,
          timeout: 1_000,
        });
        await review.captureWorkspace(page, "choose-default");
        expect(captureWithNavigation).toHaveBeenCalledTimes(2);
        expect(page.url()).toBe(expectedUrl);
        expect(review.missingShots()).toContain("choose-default");
        expect(await readdir(directory)).toEqual([]);
      } finally {
        captureWithNavigation.mockRestore();
      }
    } finally {
      await page.close();
      await rm(directory, { force: true, recursive: true });
    }
  }
);

for (const locale of ["en-US", "cs-CZ"] as const) {
  test.skipIf(!chromiumAvailable)(
    `captures the nearest canonical terms section in ${locale}`,
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "unlimited-review-"));
      const page = await browser.newPage();
      try {
        await page.route("**/*", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: '<section style="width:360px"><h1>Terms</h1><section style="width:200px"><h2>16. Unlimited</h2><p>Renewal terms</p></section></section>',
          })
        );
        await page.goto(`${origin}/${locale}/terms-and-conditions`);
        const review = makeUnlimitedPassReviewCapture({
          accountPath: `/${locale}/account/passes`,
          directory,
          locale,
          origin,
          timeout: 1_000,
        });
        await review.captureWorkspace(page, "terms");
        expect(review.missingShots()).not.toContain("terms");
        for (const width of [390, 1280]) {
          const pixels = await readFile(
            join(directory, `unlimited-${locale}-terms-${width}.png`)
          );
          expect(pixels.readUInt32BE(16)).toBe(200);
        }
      } finally {
        await page.close();
        await rm(directory, { force: true, recursive: true });
      }
    }
  );
}

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
