import { expect, mock, test } from "bun:test";
import { Effect } from "effect";
import type { Locale } from "@/features/i18n";
import type { OrderId } from "@/features/order";

let enabled = false;
const ownedOrder = "5413f44e-80ef-430e-9663-ddd7242a2ed0";

mock.module(
  "@/features/passes/backend/cowork-passes-release-gate.server",
  () => ({
    isCoworkPassesPageOpenAfterConnection: async () => enabled,
  })
);
mock.module("@/features/i18n/server/request-locale", () => ({
  runWithRequestLocale: (run: (locale: Locale) => unknown) => run("cs-CZ"),
}));
mock.module("@/features/passes/backend/unlimited-pass-capacity", () => ({
  unlimitedStartRangeMaxDays: 62,
}));
mock.module("@/features/passes/backend/unlimited-pass-purchase", () => ({
  loadUnlimitedCheckoutContinuation: () => Effect.undefined,
}));
mock.module("@/features/passes/unlimited-checkout-actions", () => ({
  beginUnlimitedCheckout: mock(),
  getUnlimitedCheckoutAvailability: mock(),
  payUnlimitedCheckout: mock(),
  repriceUnlimitedCheckout: mock(),
}));
mock.module("@/features/passes/backend/entry-pack-order", () => ({
  readOwnedPassPurchaseOrderLocale: (orderId: OrderId, product: string) =>
    Effect.succeed(
      orderId === ownedOrder && product === "unlimited" ? "en-US" : undefined
    ),
}));

const { default: UnlimitedPassPage, generateMetadata } = await import("./page");

test.each([UnlimitedPassPage, generateMetadata])(
  "a closed release keeps an owned Unlimited order reachable in its issued locale (%p)",
  async (render) => {
    await expect(
      render({
        searchParams: Promise.resolve({ order: ownedOrder, step: "pay" }),
      })
    ).rejects.toHaveProperty(
      "digest",
      `NEXT_REDIRECT;replace;/en-US/reservation/status/${ownedOrder};307;`
    );
  }
);

test.each([UnlimitedPassPage, generateMetadata])(
  "a closed release returns one not-found response for all other visitors (%p)",
  async (render) => {
    for (const order of [
      undefined,
      crypto.randomUUID(),
      "malformed",
      [ownedOrder, ownedOrder],
    ]) {
      await expect(
        render({ searchParams: Promise.resolve({ order }) })
      ).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    }
  }
);

test("the open checkout route serves noindex metadata and a selection page", async () => {
  enabled = true;
  const searchParams = Promise.resolve({
    tier: "reserved-desk-workstation",
    startDate: "2026-12-01",
  });
  expect(await generateMetadata({ searchParams })).toMatchObject({
    robots: { index: false, follow: false },
  });
  expect(await UnlimitedPassPage({ searchParams })).toBeTruthy();
});
