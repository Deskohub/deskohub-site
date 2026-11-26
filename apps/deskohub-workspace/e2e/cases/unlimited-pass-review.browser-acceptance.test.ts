import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium } from "@playwright/test";
import { playwrightChromiumAvailable } from "@/shared/testing/playwright-browser";
import { addRedaction, redact } from "../redaction";
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
const cardFieldLabels = [
  "Card number",
  "Expiration date",
  "CVV",
  "First Name",
  "Email",
];

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
        expect(review.missingShots()).toContainEqual({
          shot: "choose-default",
          problem: "document-navigated",
        });
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
        expect(review.missingShots().some(({ shot }) => shot === "terms")).toBe(
          false
        );
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
  "captures the same sandbox handoff with empty hosted iframes at both widths",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "unlimited-review-"));
    const original = { height: 720, width: 960 };
    const context = await browser.newContext({ viewport: original });
    try {
      const checkoutPage = await context.newPage();
      const page = await context.newPage();
      await context.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (url.origin === sandbox && url.pathname === hostedPath) {
          return route.fulfill({
            contentType: "text/html",
            body: cardFieldLabels
              .map(
                (label, index) =>
                  `<iframe title="${label}" src="/hosted-field/${index}"></iframe>`
              )
              .join(""),
          });
        }
        if (
          url.origin === sandbox &&
          url.pathname.startsWith("/hosted-field/")
        ) {
          const label = cardFieldLabels[Number(url.pathname.split("/").at(-1))];
          return route.fulfill({
            contentType: "text/html",
            body: `<input aria-label="${label}">`,
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
      await checkoutPage.goto(`${origin}${checkoutPath}`);
      await review.captureWorkspace(checkoutPage, "choose-default");
      await review.captureWorkspace(checkoutPage, "account-renewal");
      expect(review.missingShots()).toContainEqual({
        shot: "account-renewal",
        problem: "unexpected-document",
      });

      const syntheticPayment = "synthetic-handoff-review-order-id";
      const url = `${sandbox}${hostedPath}?orderId=${syntheticPayment}`;
      const handoff = {
        checkoutPage,
        checkoutPageUrl: `${origin}${checkoutPath}?step=pay`,
        isHandoffDocument: (candidate: typeof page) =>
          candidate === page && candidate.url() === url,
        page,
        provider: "nexi" as const,
        url,
      };
      await page.goto(url);
      const name = page
        .frameLocator('iframe[title="First Name"]')
        .getByRole("textbox", { name: "First Name" });
      await name.fill("synthetic nonempty value");
      await review.captureNexi(page, handoff, []);
      expect(review.missingShots()).toContainEqual({
        shot: "nexi-handoff",
        problem: "card-field-populated",
      });
      expect((await readdir(directory)).sort()).toEqual([
        "unlimited-cs-CZ-choose-default-1280.png",
        "unlimited-cs-CZ-choose-default-390.png",
      ]);

      addRedaction(syntheticPayment);
      const redactedHandoff = {
        ...handoff,
        url: redact(url),
      };
      const differentPayment = "synthetic-different-review-order-id";
      addRedaction(differentPayment);
      const differentUrl = `${sandbox}${hostedPath}?orderId=${differentPayment}`;
      expect(redact(differentUrl)).toBe(redactedHandoff.url);
      await page.goto(differentUrl);
      await review.captureNexi(page, redactedHandoff, []);
      expect(review.missingShots()).toContainEqual({
        shot: "nexi-handoff",
        problem: "unexpected-document",
      });

      await page.goto(url);
      const body = page.locator("body");
      const ariaSnapshot = body.ariaSnapshot.bind(body);
      const remount = spyOn(body, "ariaSnapshot").mockImplementationOnce(
        async (options) => {
          const snapshot = await ariaSnapshot(options);
          await page
            .locator('iframe[title="Card number"]')
            .evaluate((frame) => frame.replaceWith(frame.cloneNode(true)));
          await page
            .frameLocator('iframe[title="Card number"]')
            .locator("input")
            .waitFor({ state: "visible", timeout: 800 });
          return snapshot;
        }
      );
      const locator = page.locator.bind(page);
      const readBody = spyOn(page, "locator").mockImplementation(
        (selector, options) =>
          selector === "body" ? body : locator(selector, options)
      );
      try {
        await review.captureNexi(page, redactedHandoff, []);
        expect(remount).toHaveBeenCalled();
      } finally {
        readBody.mockRestore();
        remount.mockRestore();
      }
      expect(
        review.missingShots().some(({ shot }) => shot === "nexi-handoff")
      ).toBe(false);
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
      await context.close();
      await rm(directory, { force: true, recursive: true });
    }
  }
);

test.skipIf(!chromiumAvailable)(
  "reports fixed capture errors and rolls back a partial screenshot pair",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "unlimited-review-"));
    const page = await browser.newPage();
    try {
      await page.route("**/*", (route) =>
        route.fulfill({ contentType: "text/html", body: "<h1>Unlimited</h1>" })
      );
      await page.goto(`${origin}${checkoutPath}`);
      const review = makeUnlimitedPassReviewCapture({
        accountPath,
        directory,
        locale: "cs-CZ",
        origin,
        timeout: 1_000,
      });
      const screenshot = spyOn(page, "screenshot").mockRejectedValueOnce(
        new Error("synthetic private screenshot error")
      );
      try {
        await review.captureWorkspace(page, "choose-default");
        expect(review.missingShots()).toContainEqual({
          shot: "choose-default",
          problem: "screenshot-failed",
        });
        expect(await readdir(directory)).toEqual([]);
      } finally {
        screenshot.mockRestore();
      }

      const desktop = "unlimited-cs-CZ-choose-default-1280.png";
      await writeFile(join(directory, desktop), "untouched fixture");
      await review.captureWorkspace(page, "choose-default");
      expect(review.missingShots()).toContainEqual({
        shot: "choose-default",
        problem: "write-failed",
      });
      expect(await readdir(directory)).toEqual([desktop]);
      expect(await readFile(join(directory, desktop), "utf8")).toBe(
        "untouched fixture"
      );
    } finally {
      await page.close();
      await rm(directory, { force: true, recursive: true });
    }
  }
);
