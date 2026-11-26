import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type BrowserContext, chromium } from "@playwright/test";
import { Effect } from "effect";
import sharp from "sharp";
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
  {
    title: "CARD_NUMBER",
    label: "Card number",
    role: "card_number",
    preset: "placeholder",
  },
  {
    title: "EXPIRATION_DATE",
    label: "Expiration date",
    role: "expiration_date",
    preset: "default",
  },
  {
    title: "SECURITY_CODE",
    label: "CVV",
    role: "security_code",
    preset: "unavailable",
  },
] as const;
const identityFields = [
  {
    title: "CARDHOLDER_NAME",
    label: "First Name",
    value: "synthetic-private-name",
  },
  {
    title: "CARDHOLDER_EMAIL",
    label: "Email",
    value: "synthetic-private-email",
  },
] as const;
const hostedFields = [...cardFields, ...identityFields];

const serveReviewPages = (context: BrowserContext) =>
  context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === sandbox && url.pathname === hostedPath) {
      return route.fulfill({
        contentType: "text/html",
        body: hostedFields
          .map(
            ({ title }, index) =>
              `<iframe title="${title}" src="/hosted-field/${index}"></iframe>`
          )
          .join(""),
      });
    }
    if (url.origin === sandbox && url.pathname.startsWith("/hosted-field/")) {
      const field = hostedFields[Number(url.pathname.split("/").at(-1))];
      const value = field && "value" in field ? field.value : "";
      return route.fulfill({
        contentType: "text/html",
        body: `<input type="hidden" value="synthetic-hidden-frame-input"><input aria-label="${field?.label}" value="${value}">`,
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
                      ? hostedFields
                          .map(
                            ({ title }, n) =>
                              `<iframe title="${title}" src="/field/${n}"></iframe>`
                          )
                          .join("")
                      : `<input aria-label="${hostedFields[Number(index)]?.label}">`,
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

for (const [index, { label, role, title, preset }] of cardFields.entries()) {
  test.skipIf(!chromiumAvailable)(
    `reports only fixed diagnostics for a populated Nexi ${role} field`,
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "unlimited-review-"));
      const original = { height: 720, width: 960 };
      const context = await browser.newContext({ viewport: original });
      try {
        const page = await context.newPage();
        await serveReviewPages(context);
        const value = `synthetic-private-input-${role}`;
        const syntheticPayment = "synthetic-diagnostic-order-id";
        const url = `${sandbox}${hostedPath}?orderId=${syntheticPayment}`;
        await page.goto(url);
        const field = page
          .frameLocator(`iframe[title="${title}"]`)
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
            []
          );
          const logs = output.mock.calls.map(([line]) => String(line));
          const previous = cardFields.slice(0, index).map(({ role }) => ({
            role,
            state: "empty",
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
              },
            ],
          };
          expect(
            logs.filter((line) => line.startsWith("NEXI REVIEW CARD FIELDS "))
          ).toEqual([`NEXI REVIEW CARD FIELDS ${JSON.stringify(expected)}\n`]);
          expect(logs.join("")).not.toContain(value);
          expect(logs.join("")).not.toContain(syntheticPayment);
          expect(logs.join("")).not.toContain("synthetic-hidden-frame-input");
          expect(logs.join("")).not.toContain("synthetic-private-name");
          expect(logs.join("")).not.toContain("synthetic-private-email");
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
  "captures the same sandbox handoff with verified identity masks at both widths",
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
      await Promise.all([
        page.waitForEvent("framenavigated", {
          predicate: (frame) => frame === page.mainFrame(),
          timeout: 1_000,
        }),
        page.evaluate(() =>
          history.replaceState({ ready: true }, "", location.href)
        ),
      ]);
      await review.captureNexi(page, redactedHandoff, []);
      expect(
        review.missingShots().some(({ shot }) => shot === "nexi-handoff")
      ).toBe(false);
      expect(page.viewportSize()).toEqual(original);
      for (const [width, height] of [
        [390, 844],
        [1280, 900],
      ] as const) {
        await page.setViewportSize({ width, height });
        for (const shot of ["choose-default", "nexi-handoff"]) {
          const pixels = await readFile(
            join(directory, `unlimited-cs-CZ-${shot}-${width}.png`)
          );
          expect(pixels.toString("ascii", 12, 16)).toBe("IHDR");
          expect(pixels.readUInt32BE(16)).toBe(width);
          if (shot === "nexi-handoff") {
            for (const { title, label, value } of identityFields) {
              const frame = page.locator(`iframe[title="${title}"]`);
              const box = await frame.boundingBox();
              expect(box).not.toBeNull();
              if (!box) throw new Error("Hosted identity frame is missing");
              const pixel = await sharp(pixels)
                .extract({
                  left: Math.floor(box.x + box.width / 2),
                  top: Math.floor(box.y + box.height / 2),
                  width: 1,
                  height: 1,
                })
                .removeAlpha()
                .raw()
                .toBuffer();
              expect([...pixel]).toEqual([255, 0, 255]);
              expect(
                await frame
                  .contentFrame()
                  .getByRole("textbox", { name: label })
                  .inputValue()
              ).toBe(value);
            }
          }
        }
      }
    } finally {
      await context.close();
      await rm(directory, { force: true, recursive: true });
    }
  }
);

for (const [failure, problem, captures] of [
  ["missing identity frame", "identity-mask-unavailable", 0],
  ["offscreen unpainted identity frame", "identity-mask-not-rendered", 2],
  ["onscreen unpainted identity frame", "identity-mask-not-rendered", 2],
  ["transparent identity mask", "identity-mask-not-rendered", 2],
  ["remounted identity frame", "identity-mask-changed", 2],
  ["identity frame remounted before binding", "identity-mask-changed", 0],
  ["populated core control replacement", "card-controls-changed", 2],
  ["reinserted core control", "card-controls-changed", 2],
  ["main page navigation", "document-navigated", 2],
] as const) {
  test.skipIf(!chromiumAvailable)(
    `publishes neither Nexi width after ${failure}`,
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "unlimited-review-"));
      const original = { height: 720, width: 960 };
      const context = await browser.newContext({ viewport: original });
      try {
        const page = await context.newPage();
        await serveReviewPages(context);
        const url = `${sandbox}${hostedPath}?orderId=synthetic-mask-failure`;
        await page.goto(url);
        const emailFrame = page.locator('iframe[title="CARDHOLDER_EMAIL"]');
        const remountEmail = async () => {
          await Promise.all([
            page.waitForEvent("framedetached", { timeout: 1_000 }),
            emailFrame.evaluate((node) =>
              node.replaceWith(node.cloneNode(true))
            ),
          ]);
          await emailFrame
            .contentFrame()
            .getByRole("textbox", { name: "Email" })
            .waitFor({ state: "visible", timeout: 1_000 });
        };
        if (failure === "missing identity frame") {
          await emailFrame.evaluate((node) => node.remove());
        } else if (failure === "offscreen unpainted identity frame") {
          await page.addStyleTag({
            content:
              '@media (min-width: 1280px) { iframe[title="CARDHOLDER_EMAIL"] { margin-top: 1200px; } }',
          });
        }
        const screenshot = page.screenshot.bind(page);
        const injected = spyOn(page, "screenshot").mockImplementation(
          async (options) => {
            if (page.viewportSize()?.width !== 1280) return screenshot(options);
            if (
              failure === "onscreen unpainted identity frame" ||
              failure === "offscreen unpainted identity frame"
            ) {
              return screenshot({
                ...options,
                mask: options?.mask?.slice(0, -1),
              });
            }
            if (
              failure === "populated core control replacement" ||
              failure === "reinserted core control"
            ) {
              await page
                .frameLocator('iframe[title="CARD_NUMBER"]')
                .getByRole("textbox", { name: "Card number" })
                .evaluate((node, reinsert) => {
                  const replacement = node.cloneNode(true);
                  if (!(replacement instanceof HTMLInputElement)) {
                    throw new Error("Expected core card input");
                  }
                  replacement.value = "synthetic-unexpected-card-value";
                  node.replaceWith(replacement);
                  if (reinsert) replacement.replaceWith(node);
                }, failure === "reinserted core control");
            }
            const pixels = await screenshot(options);
            if (failure === "transparent identity mask") {
              const box = await emailFrame.boundingBox();
              if (!box) throw new Error("Hosted identity frame is missing");
              const { data, info } = await sharp(pixels)
                .ensureAlpha()
                .raw()
                .toBuffer({ resolveWithObject: true });
              const x = Math.floor(box.x + box.width / 2);
              const y = Math.floor(box.y + box.height / 2);
              data[(y * info.width + x) * info.channels + 3] = 0;
              return sharp(data, {
                raw: {
                  width: info.width,
                  height: info.height,
                  channels: info.channels,
                },
              })
                .png()
                .toBuffer();
            }
            if (failure === "remounted identity frame") {
              await remountEmail();
            }
            if (failure === "main page navigation") {
              await Promise.all([
                page.waitForEvent("framenavigated", {
                  predicate: (frame) => frame === page.mainFrame(),
                  timeout: 1_000,
                }),
                page.evaluate(() =>
                  history.replaceState({}, "", "/hpp/nexi/other-card")
                ),
              ]);
            }
            return pixels;
          }
        );
        try {
          const review = makeUnlimitedPassReviewCapture({
            accountPath,
            directory,
            locale: "en-US",
            origin,
            timeout: 1_000,
          });
          let documentChecks = 0;
          await review.captureNexi(
            page,
            {
              checkoutPage: page,
              checkoutPageUrl: `${origin}${checkoutPath}?step=pay`,
              isHandoffDocument: async (candidate) => {
                documentChecks++;
                if (
                  failure === "identity frame remounted before binding" &&
                  documentChecks === 3
                ) {
                  await remountEmail();
                }
                return candidate === page && candidate.url() === url;
              },
              page,
              provider: "nexi",
              url,
            },
            []
          );
          expect(review.missingShots(["nexi-handoff"])).toEqual([
            { shot: "nexi-handoff", problem },
          ]);
          expect(injected).toHaveBeenCalledTimes(captures);
          expect(await readdir(directory)).toEqual([]);
          expect(page.viewportSize()).toEqual(original);
        } finally {
          injected.mockRestore();
        }
      } finally {
        await context.close();
        await rm(directory, { force: true, recursive: true });
      }
    }
  );
}

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
