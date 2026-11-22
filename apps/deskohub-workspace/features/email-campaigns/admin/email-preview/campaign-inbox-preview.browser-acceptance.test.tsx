import { afterAll, beforeAll, expect, test } from "bun:test";
import { type Browser, chromium } from "@playwright/test";
import { renderToStaticMarkup } from "react-dom/server";
import { type Locale, locales } from "@/features/i18n";
import { RouteLocaleProvider } from "@/features/i18n/route-locale";
import { playwrightChromiumAvailable } from "@/shared/testing/playwright-browser";
import { compileWorkspaceAppStyles } from "@/shared/testing/workspace-app-styles.test-utils";
import { CampaignInboxPreview } from "./campaign-inbox-preview";

const chromiumAvailable = await playwrightChromiumAvailable();
let browser: Browser | undefined;
let appStyles = "";

beforeAll(async () => {
  if (!chromiumAvailable) return;
  appStyles = await compileWorkspaceAppStyles();
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
});

const markup = (shown: readonly Locale[], updating: boolean) =>
  renderToStaticMarkup(
    <RouteLocaleProvider locale="en-US">
      <CampaignInboxPreview
        locale={shown[0]!}
        locales={shown}
        onLocaleChange={() => undefined}
        placeholder="Synthetic placeholder"
        preheader="Synthetic preheader"
        subject="Synthetic subject"
        updating={updating}
      />
    </RouteLocaleProvider>
  );

test.skipIf(!chromiumAvailable).each([
  ["a narrow phone", 288, locales],
  ["a phone", 326, locales],
  ["the composer's side column", 416, locales],
  ["a wide section", 1100, locales],
  ["two languages", 416, ["cs-CZ", "en-US"]],
] as const)(
  "keeps every language reachable and still while updating in %s",
  async (_, width, shown) => {
    if (!browser) throw new Error("The preview browser has not been launched.");
    const context = await browser.newContext({ hasTouch: true });
    try {
      const page = await context.newPage();
      const show = async (updating: boolean) => {
        await page.setContent(
          `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><main style="width:${width}px">${markup(shown, updating)}</main></body></html>`
        );
        await page.addStyleTag({ content: appStyles });
        return page.evaluate(() => {
          const box = (element: Element) => {
            const { left, right, top, height } =
              element.getBoundingClientRect();
            return { left, right, top, height };
          };
          const card = document.querySelector("section")!;
          return {
            card: box(card),
            header: box(card.firstElementChild!),
            choices: [...card.querySelectorAll("label")].map(box),
          };
        });
      };

      const updating = await show(true);
      const idle = await show(false);
      expect(updating.header).toEqual(idle.header);
      expect(updating.choices).toEqual(idle.choices);
      expect(idle.choices).toHaveLength(shown.length);
      for (const choice of idle.choices) {
        expect(choice.left).toBeGreaterThanOrEqual(idle.card.left);
        expect(choice.right).toBeLessThanOrEqual(idle.card.right);
      }
      // A single row wherever every language fits beside the heading.
      if (width === 1100 || shown.length === 2) {
        expect(new Set(idle.choices.map(({ top }) => top)).size).toBe(1);
      }

      const radios = page.getByRole("radio");
      await radios.first().focus();
      for (let index = 1; index < shown.length; index++) {
        await page.keyboard.press("ArrowRight");
        expect(await radios.nth(index).isChecked()).toBe(true);
      }
      for (let index = 0; index < shown.length; index++) {
        await page.locator("label").nth(index).tap({ timeout: 5000 });
        expect(await radios.nth(index).isChecked()).toBe(true);
      }
    } finally {
      await context.close();
    }
  },
  30_000
);
