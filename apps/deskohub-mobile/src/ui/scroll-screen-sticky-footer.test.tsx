import { describe, expect, test } from "bun:test";
import { act, useContext, useEffect } from "react";
import { clientRoot } from "../testing/client-root";
import {
  type ContentBox,
  type PinnedFooter,
  ScrollScreen,
  StickyFooterGroup,
  type StickyFooterHost,
  StickyFooterHostContext,
  stickyFooterPinned,
  useIsPinnedCopy,
} from "./scroll-screen";
import { Text } from "./text";

const box = (y: number, height: number): ContentBox => ({
  x: 16,
  y,
  width: 328,
  height,
});

describe("stickyFooterPinned", () => {
  const group = box(100, 600);
  const footer = box(650, 50);

  test("pins while the footer's place lies below the line", () => {
    expect(stickyFooterPinned({ pinLine: 500, group, footer })).toBe(true);
  });

  test("rests in place once the line reaches the group's end", () => {
    expect(stickyFooterPinned({ pinLine: 700, group, footer })).toBe(false);
    expect(stickyFooterPinned({ pinLine: 900, group, footer })).toBe(false);
  });

  test("stays inside its group: no pin before the group shows", () => {
    expect(stickyFooterPinned({ pinLine: 149, group, footer })).toBe(false);
    expect(stickyFooterPinned({ pinLine: 150, group, footer })).toBe(true);
  });
});

/** A screen stand-in whose scroll the test moves. */
const fakeHost = (group: ContentBox, footer: ContentBox) => {
  const listeners = new Set<(change: "scroll" | "layout") => void>();
  const pins: Array<PinnedFooter | undefined> = [];
  let line = 0;
  let measured = 0;
  const host: StickyFooterHost = {
    // The group measures first, then its footer.
    measure: (_node, onBox) => onBox(measured++ % 2 === 0 ? group : footer),
    pinLine: () => line,
    belowPinned: () => 90,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    pin: (_key, pinned) => {
      pins.push(pinned);
    },
  };
  const notify = (change: "scroll" | "layout") =>
    act(() => {
      for (const listener of listeners) listener(change);
    });
  return {
    host,
    pins,
    listeners,
    layout: () => notify("layout"),
    scrollTo: (pinLine: number) => {
      line = pinLine;
      return notify("scroll");
    },
  };
};

describe("StickyFooterGroup", () => {
  const root = clientRoot();

  test("pins its footer while the group scrolls and rests it at the end", async () => {
    const screen = fakeHost(box(100, 600), box(650, 50));
    const obstructions: Array<number> = [];
    await root.render(
      <StickyFooterHostContext value={screen.host}>
        <StickyFooterGroup
          footer={<Text>footer</Text>}
          onObstruction={(height) => obstructions.push(height)}
        >
          <Text>rows</Text>
        </StickyFooterGroup>
      </StickyFooterHostContext>
    );
    await screen.scrollTo(500);
    await screen.layout();
    expect(screen.pins.at(-1)).toMatchObject({ x: 16, width: 328 });
    // The pinned copy covers its height above the screen's bottom chrome.
    expect(obstructions.at(-1)).toBe(90 + 50);

    await screen.scrollTo(720);
    expect(screen.pins.at(-1)).toBeUndefined();
    expect(obstructions.at(-1)).toBe(0);

    await screen.scrollTo(400);
    expect(screen.pins.at(-1)).toBeDefined();
  });

  test("a group without a footer never follows the scroll", async () => {
    const screen = fakeHost(box(100, 600), box(650, 50));
    await root.render(
      <StickyFooterHostContext value={screen.host}>
        <StickyFooterGroup>
          <Text>rows</Text>
        </StickyFooterGroup>
      </StickyFooterHostContext>
    );
    expect(screen.listeners.size).toBe(0);
  });

  test("assistive technology reads the footer in place, not its pinned copy", async () => {
    function Probe() {
      return <Text>{useIsPinnedCopy() ? "copy" : "place"}</Text>;
    }
    function PinsProbe() {
      const host = useContext(StickyFooterHostContext);
      useEffect(() => {
        host?.pin("probe", { node: <Probe />, x: 16, width: 328 });
      }, [host]);
      return <Probe />;
    }
    await root.render(
      <ScrollScreen>
        <PinsProbe />
      </ScrollScreen>
    );
    const texts = Array.from(root.container().querySelectorAll("Text"));
    const exposed = texts.filter(
      (text) => text.closest('[aria-hidden="true"]') === null
    );
    expect(texts.map((text) => text.textContent).sort()).toEqual([
      "copy",
      "place",
    ]);
    expect(exposed.map((text) => text.textContent)).toEqual(["place"]);
  });
});
