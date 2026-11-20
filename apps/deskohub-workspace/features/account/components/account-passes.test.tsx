import { expect, test } from "bun:test";
import { renderToReadableStream } from "react-dom/server";
import type { AccountEntryPack } from "@/features/account/account-passes.server";
import { UnsavedChangesProvider } from "@/shared/components/unsaved-changes-guard";
import { AccountPassesPanel } from "./account-passes";

test("shows the purchase date and balance, and links only the bookable pack", async () => {
  const syntheticPackId = "fixture-holder-pack";
  const openPack: AccountEntryPack = {
    position: 0,
    tier: "Open Space",
    entryCount: 5,
    entriesLeft: 3,
    boughtOn: "Oct 31, 2026",
    lastUsableDay: "Dec 30, 2026",
    status: "active",
    bookPath: `/en-US/reservation/cowork?pass=${syntheticPackId}`,
  };
  const expiredPack: AccountEntryPack = {
    position: 1,
    tier: "Reserved Desk",
    entryCount: 10,
    entriesLeft: 4,
    boughtOn: "May 31, 2026",
    lastUsableDay: "Aug 30, 2026",
    status: "expired",
  };
  const markup = await new Response(
    await renderToReadableStream(
      <UnsavedChangesProvider>
        <AccountPassesPanel
          locale="en-US"
          packs={Promise.resolve([openPack, expiredPack])}
        />
      </UnsavedChangesProvider>
    )
  ).text();

  expect(markup).toContain("Bought Oct 31, 2026");
  expect(markup).toContain("3 of 5 entries left");
  expect(markup).toContain("4 of 10 entries left");
  expect(markup).toContain("Expired");
  expect(markup).toContain(`href="${openPack.bookPath}"`);
  expect(markup.match(/Book a date/g)).toHaveLength(1);
  expect(markup.match(new RegExp(syntheticPackId, "g"))).toHaveLength(1);
});
