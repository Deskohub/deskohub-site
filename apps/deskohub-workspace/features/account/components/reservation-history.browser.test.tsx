import { afterAll, beforeAll, expect, test } from "bun:test";
import { type Browser, chromium, type Page } from "@playwright/test";
import { renderToReadableStream } from "react-dom/server";
import type { CustomerReservationSummary } from "@/features/account/contracts";
import { UnsavedChangesProvider } from "@/shared/components/unsaved-changes-guard";
import { playwrightChromiumAvailable } from "@/shared/testing/playwright-browser";
import { compileWorkspaceAppStyles } from "@/shared/testing/workspace-app-styles.test-utils";
import { ReservationHistory } from "./reservation-history";

const chromiumAvailable = await playwrightChromiumAvailable();
const viewport = { width: 390, height: 844 };
const safeAreaBottom = 34;
let browser: Browser | undefined;
let document = "";

const pastVisits = Array.from(
  { length: 14 },
  (_, index): CustomerReservationSummary => {
    const day = String(20 - index).padStart(2, "0");
    return {
      id: `synthetic-visit-${index}`,
      product: { kind: "cowork", tier: "open-space" },
      startsAt: `2026-10-${day}T08:00:00Z`,
      endsAt: `2026-10-${day}T16:00:00Z`,
      seats: 1,
      status: "confirmed",
      ...(index === 0 && { paidIndividually: true }),
    };
  }
);

beforeAll(async () => {
  if (!chromiumAvailable) return;
  const stream = await renderToReadableStream(
    <UnsavedChangesProvider>
      <ReservationHistory
        entryPacks={Promise.resolve({ held: [], boughtForOthers: [] })}
        history={{
          kind: "available",
          groups: { current: [], past: pastVisits, unavailable: [] },
        }}
        locale="en-US"
      />
    </UnsavedChangesProvider>
  );
  await stream.allReady;
  const markup = await new Response(stream).text();
  const styles = await compileWorkspaceAppStyles();
  document = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>${styles}</style></head><body><main class="px-4 pt-8 pb-64"><div class="@container min-w-0">${markup}</div></main></body></html>`;
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
});

const openHistory = async () => {
  const page = await browser!.newPage({ viewport });
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setSafeAreaInsetsOverride", {
    insets: { bottom: safeAreaBottom },
  });
  await page.setContent(document);
  return page;
};

const offerBox = async (page: Page) => {
  const box = await page.locator("[data-account-pass-savings]").boundingBox();
  if (!box) throw new Error("The packs and passes offer isn't rendered");
  return box;
};

/** Scrolls whichever element scrolls the page, as a reader's wheel does. */
const scrollBy = async (page: Page, distance: number) => {
  await page.mouse.move(viewport.width / 2, viewport.height / 2);
  await page.mouse.wheel(0, distance);
  await page.waitForFunction(
    () => new Promise((resolve) => requestAnimationFrame(() => resolve(true)))
  );
};

const lastPastRowBottom = async (page: Page) => {
  const row = await page
    .locator('[data-account-reservation-group="past"] tbody tr')
    .last()
    .boundingBox();
  if (!row) throw new Error("The past reservations aren't rendered");
  return row.y + row.height;
};

test.skipIf(!chromiumAvailable)(
  "docks the packs and passes offer above the safe area or the install bar while the list scrolls",
  async () => {
    const page = await openHistory();
    await scrollBy(page, 700);
    // Mid-list: rows continue below the docked offer.
    expect(await lastPastRowBottom(page)).toBeGreaterThan(viewport.height);
    const aboveSafeArea = await offerBox(page);
    expect(aboveSafeArea.y + aboveSafeArea.height).toBeCloseTo(
      viewport.height - safeAreaBottom,
      0
    );

    await page.evaluate(() =>
      window.document.documentElement.style.setProperty(
        "--install-bar-space",
        "72px"
      )
    );
    const aboveInstallBar = await offerBox(page);
    expect(aboveInstallBar.y + aboveInstallBar.height).toBeCloseTo(
      viewport.height - 72,
      0
    );
    await page.close();
  }
);

test.skipIf(!chromiumAvailable)(
  "rests the packs and passes offer below the last past reservation",
  async () => {
    const page = await openHistory();
    await scrollBy(page, 100_000);
    const offer = await offerBox(page);
    expect(offer.y).toBeGreaterThanOrEqual(await lastPastRowBottom(page));
    expect(offer.y + offer.height).toBeLessThan(
      viewport.height - safeAreaBottom
    );
    await page.close();
  }
);
