import type { CDPSession, Page } from "@playwright/test";

const urlRelation = (initial: string, current: string) => {
  if (initial === current) return "same-url";
  return initial.split("#", 1)[0] === current.split("#", 1)[0]
    ? "fragment-change"
    : "different-url";
};

type MainNavigationEvent =
  `${"document" | "fragment" | "historyApi" | "other"}-${ReturnType<typeof urlRelation>}`;

/** Observes only the opt-in screenshot window and never records URLs or IDs. */
export function observeNexiReviewNavigation(page: Page) {
  const initial = page.url();
  const mainEvents = new Set<MainNavigationEvent>();
  let subframeNavigated = false;
  let mainFrameId: string | undefined;
  let session: CDPSession | undefined;
  let finished = false;
  let observer: "starting" | "ready" | "unavailable" = "starting";

  const detach = () => {
    void session?.detach().catch(() => undefined);
    session = undefined;
  };
  const ready = (async () => {
    try {
      session = await page.context().newCDPSession(page);
      if (finished) {
        detach();
        return;
      }
      session.on("Page.frameNavigated", ({ frame }) => {
        if (frame.parentId) {
          subframeNavigated = true;
        } else {
          mainFrameId = frame.id;
          const url = frame.url + (frame.urlFragment ?? "");
          mainEvents.add(`document-${urlRelation(initial, url)}`);
        }
      });
      session.on("Page.navigatedWithinDocument", (event) => {
        if (!mainFrameId) return;
        if (event.frameId !== mainFrameId) {
          subframeNavigated = true;
          return;
        }
        const kind =
          event.navigationType === "fragment" ||
          event.navigationType === "historyApi"
            ? event.navigationType
            : "other";
        mainEvents.add(`${kind}-${urlRelation(initial, event.url)}`);
      });
      const { frameTree } = await session.send("Page.getFrameTree");
      mainFrameId = frameTree.frame.id;
      await session.send("Page.enable");
      observer = "ready";
    } catch {
      observer = "unavailable";
      detach();
    }
  })();

  return {
    ready,
    finish: () => {
      finished = true;
      const final = page.isClosed()
        ? "closed"
        : urlRelation(initial, page.url());
      detach();
      return {
        observer,
        mainEvents: [...mainEvents],
        subframeNavigated,
        final,
      };
    },
  };
}
