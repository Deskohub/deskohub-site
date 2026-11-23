import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Effect, Layer } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { testCustomerSession } from "@/features/account/backend/account-operations.test-utils";
import {
  CurrentCustomerAccount,
  requireVerifiedIdentity,
} from "@/features/account/backend/current-customer-account";
import { orderIdSchema } from "@/features/order";
import { runWorkspaceEffectOrElse } from "@/shared/backend/workspace-effect";
import { plainDateStringSchema } from "@/shared/utils/temporal";

type HeldUnlimitedPass = Effect.Success<
  ReturnType<
    typeof import("@/features/passes/backend/held-unlimited-passes").listHeldUnlimitedPasses
  >
>[number];

class UnlimitedReadFailure extends Error {}

let heldUnlimitedPasses: Effect.Effect<
  readonly HeldUnlimitedPass[],
  UnlimitedReadFailure
> = Effect.succeed([]);
const listHeldUnlimitedPasses = mock(() => heldUnlimitedPasses);
const listHeldEntryPacks = mock(() => Effect.succeed([]));

const heldUnlimitedPassReads = await import(
  "@/features/passes/backend/held-unlimited-passes"
);
mock.module("@/features/passes/backend/held-unlimited-passes", () => ({
  ...heldUnlimitedPassReads,
  listHeldUnlimitedPasses,
}));
const heldEntryPackReads = await import(
  "@/features/passes/backend/held-entry-packs"
);
mock.module("@/features/passes/backend/held-entry-packs", () => ({
  ...heldEntryPackReads,
  listHeldEntryPacks,
}));
const entryPackGifts = await import(
  "@/features/passes/backend/entry-pack-gift"
);
mock.module("@/features/passes/backend/entry-pack-gift", () => ({
  ...entryPackGifts,
  recoverEntryPackGiftClaims: () => Effect.void,
}));

const { loadCoworkCustomerPasses, unreadCoworkCustomerPasses } = await import(
  "./cowork-customer-passes"
);

const unlimitedPass = (
  overrides: Partial<HeldUnlimitedPass>
): HeldUnlimitedPass => ({
  orderId: orderIdSchema.make(crypto.randomUUID()),
  tier: "open-space",
  buyerAccountId: testCustomerSession.accountId,
  validFrom: plainDateStringSchema.make("2099-07-20"),
  validUntil: plainDateStringSchema.make("2099-08-19"),
  accessEndsOn: null,
  status: "active",
  paidAt: Temporal.Instant.from("2099-07-01T10:00:00Z"),
  grantedAt: Temporal.Instant.from("2099-07-01T10:00:00Z"),
  paymentState: "paid",
  renewalOverlaps: false,
  deskId: null,
  ...overrides,
});

const load = (signedIn = true) =>
  loadCoworkCustomerPasses(undefined).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(WorkspaceDatabase, {}),
        Layer.mock(CurrentCustomerAccount, {
          requireActive: requireVerifiedIdentity(
            signedIn ? testCustomerSession : null
          ),
        })
      )
    ),
    // The page serves the same fallback when the read fails.
    runWorkspaceEffectOrElse("cowork.load-booking-passes.test", {
      failureCode: "cowork.booking-passes-unavailable",
      orElse: () => unreadCoworkCustomerPasses,
    })
  );

const originalNow = Temporal.Now.instant;
beforeEach(() => {
  mock.clearAllMocks();
  heldUnlimitedPasses = Effect.succeed([]);
  Temporal.Now.instant = () => Temporal.Instant.from("2099-07-30T10:00:00Z");
});
afterEach(() => {
  Temporal.Now.instant = originalNow;
});

describe("loadCoworkCustomerPasses", () => {
  test("offers passes to a visitor without reading any", async () => {
    expect(await load(false)).toEqual({
      bookingPasses: { packs: [], claimedDates: [] },
      passPurchaseOffered: true,
    });
    expect(listHeldUnlimitedPasses).not.toHaveBeenCalled();
  });

  test("offers passes to a signed-in customer without an Unlimited pass", async () => {
    expect((await load()).passPurchaseOffered).toBe(true);
    expect(listHeldUnlimitedPasses).toHaveBeenCalledWith(
      testCustomerSession.accountId
    );
  });

  test.each([
    ["an active", unlimitedPass({})],
    [
      "an upcoming",
      unlimitedPass({
        validFrom: plainDateStringSchema.make("2099-08-05"),
        validUntil: plainDateStringSchema.make("2099-09-04"),
      }),
    ],
    [
      "a withdrawn but still accessible",
      unlimitedPass({
        status: "withdrawn",
        accessEndsOn: plainDateStringSchema.make("2099-08-01"),
      }),
    ],
  ])(
    "withholds passes from a customer holding %s Unlimited pass",
    async (_, pass) => {
      heldUnlimitedPasses = Effect.succeed([pass]);
      expect((await load()).passPurchaseOffered).toBe(false);
    }
  );

  test.each([
    [
      "an expired",
      unlimitedPass({
        validFrom: plainDateStringSchema.make("2099-06-01"),
        validUntil: plainDateStringSchema.make("2099-07-01"),
      }),
    ],
    ["an ended", unlimitedPass({ status: "cancelled" })],
  ])(
    "offers passes to a customer holding only %s Unlimited pass",
    async (_, pass) => {
      heldUnlimitedPasses = Effect.succeed([pass]);
      expect((await load()).passPurchaseOffered).toBe(true);
    }
  );

  test("withholds passes when a signed-in customer's passes can't be read", async () => {
    heldUnlimitedPasses = Effect.fail(new UnlimitedReadFailure());
    expect(await load()).toEqual({
      bookingPasses: { packs: [], claimedDates: [] },
      passPurchaseOffered: false,
    });
  });
});
