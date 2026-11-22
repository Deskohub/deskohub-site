import { afterAll, beforeAll, expect, test } from "bun:test";
import { type Browser, chromium } from "@playwright/test";
import { renderToStaticMarkup } from "react-dom/server";
import { m } from "@/features/administration/i18n";
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

const markup = ({
  routeLocale = "en-US",
  shown,
  updating,
}: {
  readonly routeLocale?: Locale;
  readonly shown: readonly Locale[];
  readonly updating?: boolean;
}) =>
  renderToStaticMarkup(
    <RouteLocaleProvider locale={routeLocale}>
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

const openPage = async (body: string) => {
  if (!browser) throw new Error("The preview browser has not been launched.");
  const context = await browser.newContext({ hasTouch: true });
  const page = await context.newPage();
  await page.setContent(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body>${body}</body></html>`
  );
  await page.addStyleTag({ content: appStyles });
  return { context, page };
};

test.skipIf(!chromiumAvailable).each([
  ["a narrow phone", 288, locales],
  ["a phone", 326, locales],
  ["the composer's side column", 416, locales],
  ["a wide section", 1100, locales],
  ["a phone with two languages", 326, ["cs-CZ", "en-US"]],
] as const)(
  "keeps every language reachable in %s",
  async (_, width, shown) => {
    const { context, page } = await openPage(
      `<main style="width:${width}px">${markup({ shown })}</main>`
    );
    try {
      const { card, choices, heading } = await page.evaluate(() => {
        const box = (element: Element) => {
          const { left, right, top, bottom } = element.getBoundingClientRect();
          return { left, right, top, bottom };
        };
        const section = document.querySelector("section")!;
        return {
          card: box(section),
          heading: box(section.querySelector("h2")!),
          choices: [...section.querySelectorAll("label")].map(box),
        };
      });
      expect(choices).toHaveLength(shown.length);
      for (const choice of choices) {
        expect(choice.left).toBeGreaterThanOrEqual(card.left);
        expect(choice.right).toBeLessThanOrEqual(card.right);
      }
      // One row beside the heading wherever every language fits there.
      if (width === 1100 || shown.length === 2) {
        for (const choice of choices) {
          expect(choice.top).toBeLessThan(heading.bottom);
        }
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

test.skipIf(!chromiumAvailable).each([...locales])(
  "shows the whole updating label without moving the languages at any width in %s",
  async (routeLocale) => {
    const { context, page } = await openPage(
      [true, false]
        .map(
          (updating) =>
            `<main>${markup({ routeLocale, shown: locales, updating })}</main>`
        )
        .join("")
    );
    try {
      const failures = await page.evaluate(
        (label) => {
          const failed: string[] = [];
          const [busy, idle] = [...document.querySelectorAll("main")];
          const layout = (main: Element) => {
            const card = main.querySelector("section")!;
            const origin = card.getBoundingClientRect();
            return JSON.stringify(
              [card.firstElementChild!, ...card.querySelectorAll("label")].map(
                (element) => {
                  const box = element.getBoundingClientRect();
                  return [box.x - origin.x, box.y - origin.y, box.height].map(
                    Math.round
                  );
                }
              )
            );
          };
          const text = document.createRange();
          const shownLabel = [...busy!.querySelectorAll("span")].find(
            (span) =>
              span.textContent === label &&
              span.getBoundingClientRect().width > 1
          )!;
          text.selectNodeContents(shownLabel);
          for (let width = 288; width <= 1100; width += 4) {
            busy!.style.width = idle!.style.width = `${width}px`;
            if (layout(busy!) !== layout(idle!)) failed.push(`moved ${width}`);
            const inner = text.getBoundingClientRect();
            const outer = shownLabel.getBoundingClientRect();
            const card = busy!
              .querySelector("section")!
              .getBoundingClientRect();
            if (
              inner.left < Math.max(outer.left, card.left) - 0.5 ||
              inner.right > Math.min(outer.right, card.right) + 0.5
            ) {
              failed.push(`clipped ${width}`);
            }
          }
          return failed;
        },
        m.emailCampaignsEmailPreviewUpdating({}, { locale: routeLocale })
      );
      expect(failures).toEqual([]);
    } finally {
      await context.close();
    }
  },
  30_000
);
