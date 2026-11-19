import { expect, mock, test } from "bun:test";
import type { Locale } from "@/features/i18n";

let enabled = false;
mock.module(
  "@/features/passes/backend/cowork-passes-release-gate.server",
  () => ({
    isCoworkPassesPageOpenAfterConnection: async () => enabled,
  })
);
mock.module("@/features/i18n/server/request-locale", () => ({
  runWithRequestLocale: (run: (locale: Locale) => unknown) => run("en-US"),
}));

const { default: EntryPackPage } = await import("./page");
const searchParams = Promise.resolve({ tier: "open-space", size: "5" });

test("the localized checkout route returns not found while passes are off", async () => {
  await expect(EntryPackPage({ searchParams })).rejects.toThrow(
    "NEXT_HTTP_ERROR_FALLBACK;404"
  );
});

test("while passes are off a saved order still reaches its private status", async () => {
  const order = crypto.randomUUID();
  try {
    await EntryPackPage({ searchParams: Promise.resolve({ order }) });
    throw new Error("No redirect for the saved order");
  } catch (error) {
    expect(error).toHaveProperty(
      "digest",
      `NEXT_REDIRECT;replace;/en-US/reservation/status/${order};307;`
    );
  }
});

test("the localized checkout route opens when passes are available", async () => {
  enabled = true;
  expect(await EntryPackPage({ searchParams })).toBeTruthy();
});
