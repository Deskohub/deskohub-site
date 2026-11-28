import { expect, test } from "bun:test";
import { chromium } from "@playwright/test";
import { playwrightChromiumAvailable } from "@/shared/testing/playwright-browser";
import { observeNexiReviewNavigation } from "./nexi-review-navigation";

const chromiumAvailable = await playwrightChromiumAvailable();

test.skipIf(!chromiumAvailable)(
  "reports the actual main document lifecycle without the handoff URL or frame IDs",
  async () => {
    const browser = await chromium.launch();
    const initial = "https://nexi.example.test/hpp/fake-private-order";
    try {
      const page = await browser.newPage();
      await page.route("**/*", (route) =>
        route.fulfill({
          contentType: "text/html",
          body:
            route.request().isNavigationRequest() &&
            route.request().frame() === page.mainFrame()
              ? '<iframe title="card field" src="/fake-private-iframe"></iframe>'
              : "<input aria-label='Card number'>",
        })
      );
      await page.goto(initial);
      const observer = observeNexiReviewNavigation(page);
      await observer.ready;
      await page.evaluate(() =>
        history.replaceState({ ready: true }, "", location.href)
      );
      await page.evaluate(() => {
        location.hash = "fake-private-fragment";
      });
      await page.evaluate(() =>
        history.replaceState({}, "", "?fake-private-query")
      );
      await page.evaluate((url) => history.replaceState({}, "", url), initial);
      await page.reload();

      const report = observer.finish();
      expect(report.observer).toBe("ready");
      expect(report.mainEvents).toEqual(
        expect.arrayContaining([
          "historyApi-same-url",
          "fragment-fragment-change",
          "historyApi-different-url",
          "document-same-url",
        ])
      );
      expect(report.subframeNavigated).toBe(true);
      expect(report.final).toBe("same-url");
      expect(JSON.stringify(report)).not.toContain("fake-private");
    } finally {
      await browser.close();
    }
  }
);
