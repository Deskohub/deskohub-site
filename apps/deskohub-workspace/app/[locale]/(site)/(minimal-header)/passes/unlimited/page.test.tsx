import { expect, mock, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import { Effect } from "effect";
import type { Locale } from "@/features/i18n";
import type { OrderId } from "@/features/order";

let enabled = false;
let buyerSignedIn = true;
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
mock.module("@/features/passes/backend/pass-purchase-buyer", () => ({
  readPassPurchaseBuyer: () =>
    Effect.succeed(
      buyerSignedIn
        ? {
            kind: "linked",
            name: "Fixture Buyer",
            email: testEmailAddress("unlimited-route-buyer"),
          }
        : { kind: "signed-out" }
    ),
}));
mock.module("@/features/discounts/discount-code-entry.server", () => ({
  getDiscountCodeEntryEnabled: Effect.succeed(false),
}));
mock.module("@/features/passes/backend/unlimited-pass-purchase", () => ({
  loadUnlimitedCheckoutContinuation: (orderId: OrderId) =>
    Effect.succeed(
      buyerSignedIn && orderId === ownedOrder
        ? {
            locale: "cs-CZ",
            selection: { tier: "reserved-desk", startDate: "2026-12-01" },
          }
        : undefined
    ),
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

const editedSelectionQuery = {
  tier: "open-space",
  startDate: "2026-12-15",
  coffee: "true",
  step: "details",
  supersedeOrder: ownedOrder,
};

async function renderContent(query: typeof editedSelectionQuery) {
  const page = await UnlimitedPassPage({
    searchParams: Promise.resolve(query),
  });
  const content = page.props.children;
  return content.type(content.props);
}

test("an owned replacement survives reload with the edited selection", async () => {
  const content = await renderContent(editedSelectionQuery);
  expect(content.props.children.props).toMatchObject({
    draft: { kind: "replace", orderId: ownedOrder },
    initialDetails: {
      tier: "open-space",
      startDate: "2026-12-15",
      coffee: true,
    },
  });
});

test("sign-in continues to the same edited selection and checks predecessor ownership", async () => {
  buyerSignedIn = false;
  try {
    await expect(renderContent(editedSelectionQuery)).rejects.toHaveProperty(
      "digest",
      expect.stringContaining(
        `startDate%3D2026-12-15%26supersedeOrder%3D${ownedOrder}`
      )
    );
  } finally {
    buyerSignedIn = true;
  }
  await expect(
    renderContent({
      ...editedSelectionQuery,
      supersedeOrder: crypto.randomUUID(),
    })
  ).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
});
