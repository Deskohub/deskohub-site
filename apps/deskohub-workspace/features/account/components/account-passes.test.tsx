import { expect, test } from "bun:test";
import { renderToReadableStream } from "react-dom/server";
import type {
  AccountBoughtEntryPack,
  AccountEntryPack,
} from "@/features/account/account-passes.server";
import { orderIdSchema } from "@/features/order";
import "@/shared/testing/workspace-component-module-mocks";
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
          packs={Promise.resolve({
            held: [openPack, expiredPack],
            boughtForOthers: [],
          })}
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

test("presents the buyer's order separately from passes they can use", async () => {
  const orderId = orderIdSchema.make(crypto.randomUUID());
  const statusPath = `/en-US/reservation/status/${orderId}`;
  const gift: AccountBoughtEntryPack = {
    orderId,
    statusPath,
    tier: "Open Space",
    entryCount: 5,
    maskedHolderEmail: "a•••@example.test",
    invitation: "sent",
    claimed: false,
    canResend: true,
  };
  const markup = await new Response(
    await renderToReadableStream(
      <UnsavedChangesProvider>
        <AccountPassesPanel
          locale="en-US"
          packs={Promise.resolve({ held: [], boughtForOthers: [gift] })}
        />
      </UnsavedChangesProvider>
    )
  ).text();

  expect(markup).toContain("Bought for others");
  expect(markup).toContain("For a•••@example.test");
  expect(markup).toContain(`href="${statusPath}"`);
  expect(markup).toContain("Invitation sent");
  expect(markup).toContain("Not claimed yet");
  expect(markup).toContain("Resend invitation");
  expect(markup).not.toContain("entries left");
  expect(markup).not.toContain("Book a date");
  expect(markup).not.toContain("You don’t have any Entry packs yet.");
});
