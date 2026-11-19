import { expect, test } from "bun:test";
import { join } from "node:path";
import { chromium, expect as expectInBrowser } from "@playwright/test";
import { playwrightChromiumAvailable } from "@/shared/testing/playwright-browser";
import { compileWorkspaceAppStyles } from "@/shared/testing/workspace-app-styles.test-utils";

test.skipIf(!(await playwrightChromiumAvailable()))(
  "the dialog and backdrop stay transparent when the exit animation finishes",
  async () => {
    const [bundle, appStyles] = await Promise.all([
      Bun.build({
        entrypoints: [join(import.meta.dir, "dialog.browser-harness.tsx")],
        target: "browser",
      }),
      compileWorkspaceAppStyles(),
    ]);
    const [script] = bundle.outputs;
    if (!script) throw new Error("The dialog browser harness failed to build.");

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({
        viewport: { width: 1896, height: 1212 },
      });
      await page.setContent('<!doctype html><div id="root"></div>');
      await page.addStyleTag({ content: appStyles });
      await page.addScriptTag({ content: await script.text(), type: "module" });

      const trigger = page.getByRole("button", { name: "Open dialog" });
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: "Reservation dialog" });
      const exitOpacity = await dialog.evaluate(async (panel) => {
        const backdrop = panel.previousElementSibling;
        if (!backdrop) throw new Error("The dialog backdrop is missing.");
        const closeButton = panel.querySelector("button");
        if (!closeButton) throw new Error("The close button is missing.");

        const closed = new Promise<void>((resolve) => {
          const observer = new MutationObserver(() => {
            if (panel.getAttribute("data-state") === "closed") {
              observer.disconnect();
              resolve();
            }
          });
          observer.observe(panel, { attributeFilter: ["data-state"] });
        });
        closeButton.click();
        await closed;

        return [panel, backdrop].map((element) => {
          const [exit] = element.getAnimations();
          if (!exit?.effect) throw new Error("The exit animation is missing.");
          const { endTime } = exit.effect.getComputedTiming();
          // Sample the endpoint before Radix handles animationend and unmounts.
          exit.pause();
          exit.currentTime = endTime / 2;
          const midpoint = Number(getComputedStyle(element).opacity);
          exit.currentTime = endTime;
          const end = Number(getComputedStyle(element).opacity);
          exit.currentTime = endTime / 2;
          exit.play();
          return { midpoint, end };
        });
      });
      for (const { midpoint, end } of exitOpacity) {
        expect(midpoint).toBeGreaterThan(0);
        expect(midpoint).toBeLessThan(1);
        expect(end).toBe(0);
      }
      await expectInBrowser(dialog).toHaveCount(0);
      await expectInBrowser(trigger).toBeFocused();
    } finally {
      await browser.close();
    }
  }
);
