import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type BrowserContext, chromium } from "@playwright/test";
import { Effect } from "effect";
import { playwrightChromiumAvailable } from "@/shared/testing/playwright-browser";
import {
  type CurrentBrowserDocument,
  readActivePage,
  waitForPageUrl,
} from "../browser";
import { runBrowserStep } from "../case-runner.browser.test-utils";
import { nexiReviewReadyUrl } from "../checkout/nexi-review-navigation";
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
const cardFields = [
  { label: "Card number", role: "card_number", preset: "placeholder" },
  { label: "Expiration date", role: "expiration_date", preset: "default" },
  { label: "CVV", role: "security_code", preset: "unavailable" },
  { label: "First Name", role: "cardholder_name" },
  { label: "Email", role: "cardholder_email" },
] as const;
const cardFieldLabels = cardFields.map(({ label }) => label);

const serveReviewPages = (context: BrowserContext) =>
  context.route("**/*", (route) => {
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
    if (url.origin === sandbox && url.pathname.startsWith("/hosted-field/")) {
      const label = cardFieldLabels[Number(url.pathname.split("/").at(-1))];
      return route.fulfill({
        contentType: "text/html",
        body: `<input type="hidden" value="synthetic-hidden-frame-input"><input aria-label="${label}">`,
      });
    }
    return route.fulfill({
      contentType: "text/html",
      body: '<main><h1>Unlimited</h1><span data-ph-mask>masked</span><input value="synthetic form value"></main>',
    });
  });

for (const transition of [
  "card",
  "card-during-match",
  "different-operation",
  "reload",
  "reload-during-match",
  "return",
] as const) {
  test.skipIf(!chromiumAvailable)(
    `checks the exact Nexi card bootstrap: ${transition}`,
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "unlimited-review-"));
      const initial = `${sandbox}/hpp/nexi/card-bootstrap-session?operationId=bootstrap-operation`;
      const ready = `${sandbox}/hpp/nexi/card-bootstrap-session/card?operationId=bootstrap-operation`;
      try {
        const review = makeUnlimitedPassReviewCapture({
          accountPath,
          directory,
          locale: "en-US",
          origin,
          timeout: 1_000,
        });
        const execution = await runBrowserStep({
          browser,
          prepare: (session) =>
            session.use("open synthetic Nexi bootstrap page", async (page) => {
              await page.route("**/*", (route) => {
                const url = new URL(route.request().url());
                const index = url.pathname.match(/^\/field\/([0-4])$/)?.[1];
                return route.fulfill({
                  contentType: "text/html",
                  body:
                    index === undefined
                      ? cardFieldLabels
                          .map(
                            (label, n) =>
                              `<iframe title="${label}" src="/field/${n}"></iframe>`
                          )
                          .join("")
                      : `<input aria-label="${cardFieldLabels[Number(index)]}">`,
                });
              });
              await page.goto(initial);
            }),
          drive: ({ session }) =>
            Effect.gen(function* () {
              let isHandoffDocument: CurrentBrowserDocument | undefined;
              let earlyTransition: Promise<unknown> | undefined;
              const matchingPage = yield* readActivePage(session);
              yield* waitForPageUrl({
                description: "synthetic Nexi handoff",
                documentReadyUrl: nexiReviewReadyUrl,
                matches: (url) => {
                  if (url !== initial) return false;
                  if (transition === "card-during-match") {
                    earlyTransition = matchingPage.evaluate(
                      (target) => history.replaceState({}, "", target),
                      ready
                    );
                  } else if (transition === "reload-during-match") {
                    earlyTransition = matchingPage
                      .reload()
                      .then(() =>
                        matchingPage.evaluate(
                          (target) => history.replaceState({}, "", target),
                          ready
                        )
                      );
                  }
                  return true;
                },
                onDocumentMatch: (document) => {
                  isHandoffDocument = document;
                },
                session,
                timeoutMs: 1_000,
              });
              yield* session.use(
                "capture the synthetic Nexi bootstrap",
                async (page) => {
                  const handoff = {
                    checkoutPage: page,
                    checkoutPageUrl: `${origin}${checkoutPath}`,
                    isHandoffDocument,
                    page,
                    provider: "nexi" as const,
                    url: initial,
                  };
                  if (earlyTransition) {
                    await earlyTransition;
                    await review.captureNexi(page, handoff, []);
                    return;
                  }
                  await page.evaluate(() => document.body !== null);
                  const replace = async (url: string) => {
                    await Promise.all([
                      page.waitForEvent("framenavigated", {
                        predicate: (frame) => frame === page.mainFrame(),
                        timeout: 1_000,
                      }),
                      page.evaluate(
                        (target) => history.replaceState({}, "", target),
                        url
                      ),
                    ]);
                  };
                  const pending = review.captureNexi(page, handoff, []);
                  if (transition === "reload") {
                    await page.goto(ready);
                  } else if (transition === "different-operation") {
                    await replace(
                      ready.replace(
                        "bootstrap-operation",
                        "different-operation"
                      )
                    );
                  } else {
                    await replace(ready);
                    if (transition === "return") {
                      await replace(initial);
                      await replace(ready);
                    }
                  }
                  await pending;
                }
              );
            }),
        });
        expect(execution.succeeded).toBe(true);
        const files = (await readdir(directory)).sort();
        if (transition === "card" || transition === "card-during-match") {
          expect(files).toEqual([
            "unlimited-en-US-nexi-handoff-1280.png",
            "unlimited-en-US-nexi-handoff-390.png",
          ]);
        } else {
          expect(files).toEqual([]);
        }
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    }
  );
}

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

for (const [index, entry] of cardFields.entries()) {
  test.skipIf(!chromiumAvailable)(
    `reports only fixed diagnostics for a populated Nexi ${entry.role} field`,
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "unlimited-review-"));
      const original = { height: 720, width: 960 };
      const context = await browser.newContext({ viewport: original });
      try {
        const page = await context.newPage();
        await serveReviewPages(context);
        const { label, role } = entry;
        const preset = "preset" in entry ? entry.preset : undefined;
        const value = `synthetic-private-input-${role}`;
        const syntheticPayment = "synthetic-diagnostic-order-id";
        const url = `${sandbox}${hostedPath}?orderId=${syntheticPayment}`;
        await page.goto(url);
        if (role === "cardholder_email") {
          await page
            .locator('iframe[title="First Name"]')
            .evaluate((el) => el.remove());
        }
        const field = page
          .frameLocator(`iframe[title="${label}"]`)
          .getByRole("textbox", { name: label });
        if (preset) {
          await field.evaluate(
            (el, { preset, value }) => {
              if (!(el instanceof HTMLInputElement)) {
                throw new Error("Expected a hosted-field input");
              }
              if (preset === "default") el.defaultValue = value;
              else if (preset === "placeholder") el.placeholder = value;
              else {
                el.matches = () => {
                  throw new Error(value);
                };
              }
            },
            { preset, value }
          );
        }
        await field.fill(value);
        const review = makeUnlimitedPassReviewCapture({
          accountPath,
          directory,
          locale: "cs-CZ",
          origin,
          timeout: 1_000,
        });
        const output = spyOn(process.stdout, "write").mockImplementation(
          () => true
        );
        try {
          await review.captureNexi(
            page,
            {
              checkoutPage: page,
              checkoutPageUrl: `${origin}${checkoutPath}?step=pay`,
              isHandoffDocument: async (candidate) =>
                candidate === page && candidate.url() === url,
              page,
              provider: "nexi",
              url,
            },
            [],
            {
              email: "synthetic-expected-email",
              name: "synthetic-private-input-cardholder_name",
            }
          );
          const logs = output.mock.calls.map(([line]) => String(line));
          const previous = cardFields
            .slice(0, index)
            .map(({ role: previousRole }) => ({
              role: previousRole,
              state:
                role === "cardholder_email" &&
                previousRole === "cardholder_name"
                  ? "missing"
                  : "empty",
            }));
          const expected = {
            problem: "card-field-populated",
            fields: [
              ...previous,
              {
                role,
                state: "populated",
                details:
                  preset === "unavailable"
                    ? "unavailable"
                    : {
                        autofilled: false,
                        matchesDefaultValue: preset === "default",
                        matchesPlaceholder: preset === "placeholder",
                      },
                ...((role === "cardholder_name" ||
                  role === "cardholder_email") && {
                  matchesSyntheticBuyer: role === "cardholder_name",
                }),
              },
            ],
          };
          expect(
            logs.filter((line) => line.startsWith("NEXI REVIEW CARD FIELDS "))
          ).toEqual([`NEXI REVIEW CARD FIELDS ${JSON.stringify(expected)}\n`]);
          expect(logs.join("")).not.toContain(value);
          expect(logs.join("")).not.toContain(syntheticPayment);
          expect(logs.join("")).not.toContain("synthetic-hidden-frame-input");
          expect(logs.join("")).not.toContain("synthetic-expected-email");
        } finally {
          output.mockRestore();
        }
        expect(review.missingShots()).toContainEqual({
          shot: "nexi-handoff",
          problem: "card-field-populated",
        });
        expect(await readdir(directory)).toEqual([]);
        expect(await field.inputValue()).toBe(value);
        expect(page.viewportSize()).toEqual(original);
      } finally {
        await context.close();
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
      await serveReviewPages(context);

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
        isHandoffDocument: async (candidate: typeof page) =>
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
          await Promise.all([
            page.waitForEvent("framenavigated", {
              predicate: (frame) => frame === page.mainFrame(),
              timeout: 1_000,
            }),
            page.evaluate(() =>
              history.replaceState({ ready: true }, "", location.href)
            ),
          ]);
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
