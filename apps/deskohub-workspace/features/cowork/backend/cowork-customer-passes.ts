import "server-only";

import { Effect, Option } from "effect";
import {
  WorkspaceDatabase,
  workspaceStatementConcurrency,
} from "@/db/database.service";
import { CurrentCustomerAccount } from "@/features/account/backend/current-customer-account";
import type { CustomerAccountId } from "@/features/account/customer-account";
import { isCurrentUnlimitedPass } from "@/features/passes/backend/customer-pass-coverage";
import { recoverEntryPackGiftClaims } from "@/features/passes/backend/entry-pack-gift";
import { listHeldEntryPacks } from "@/features/passes/backend/held-entry-packs";
import { listHeldUnlimitedPasses } from "@/features/passes/backend/held-unlimited-passes";
import { listUnlimitedPassCoverageWindows } from "@/features/passes/backend/unlimited-pass-window";
import { getCurrentWorkspaceDate } from "@/features/reservation/reservation-date";
import { type PlainDate, plainDateStringSchema } from "@/shared/utils/temporal";
import {
  type CoworkEntryPacks,
  getCoworkBookingPasses,
  noCoworkBookingPasses,
} from "../cowork-entry-packs";

/** The customer's passes as the Cowork form uses them. */
export type CoworkCustomerPasses = {
  /** The Entry packs the customer can book with. */
  readonly bookingPasses: CoworkEntryPacks;
  /**
   * Whether the form offers passes to buy: not while the customer holds an
   * Unlimited pass the account page shows as active or upcoming.
   */
  readonly passPurchaseOffered: boolean;
};

/** A visitor without an active account has no pass and may buy one. */
const visitorCoworkPasses: CoworkCustomerPasses = {
  bookingPasses: noCoworkBookingPasses,
  passPurchaseOffered: true,
};

/**
 * What the form gets when a signed-in customer's passes can't be read: no
 * Entry pack to book with, and no pass to buy, since one they already hold
 * may cover the visit.
 */
export const unreadCoworkCustomerPasses: CoworkCustomerPasses = {
  bookingPasses: noCoworkBookingPasses,
  passPurchaseOffered: false,
};

/** Marks the dates on which an Unlimited pass leaves an Entry pack unusable. */
const withUnlimitedCoveredDates = Effect.fn("cowork.withUnlimitedCoveredDates")(
  function* (
    accountId: CustomerAccountId,
    today: PlainDate,
    booking: CoworkEntryPacks
  ) {
    const [firstPack] = booking.packs;
    if (!firstPack) return booking;

    const window = booking.packs.reduce(
      (range, pack) => ({
        validFrom:
          pack.validFrom < range.validFrom ? pack.validFrom : range.validFrom,
        validUntil:
          pack.validUntil > range.validUntil
            ? pack.validUntil
            : range.validUntil,
      }),
      { validFrom: firstPack.validFrom, validUntil: firstPack.validUntil }
    );
    const { db } = yield* WorkspaceDatabase;
    const coverage = yield* listUnlimitedPassCoverageWindows(db, accountId, {
      validFrom: window.validFrom > today ? window.validFrom : today,
      validUntil: window.validUntil,
      tiers: [...new Set(booking.packs.map((pack) => pack.tier))],
    });

    // Project only dates on which this Entry pack cannot be used.
    return {
      ...booking,
      packs: booking.packs.map((pack) => {
        const unavailableDates = new Set<PlainDate>();
        const packStart = pack.validFrom > today ? pack.validFrom : today;
        for (const covered of coverage) {
          if (covered.tier !== pack.tier) continue;
          const start =
            covered.validFrom > packStart ? covered.validFrom : packStart;
          const end =
            covered.validUntil < pack.validUntil
              ? covered.validUntil
              : pack.validUntil;
          for (
            let day = Temporal.PlainDate.from(start);
            day.toString() < end;
            day = day.add({ days: 1 })
          ) {
            unavailableDates.add(plainDateStringSchema.make(day.toString()));
          }
        }
        return unavailableDates.size > 0
          ? { ...pack, unavailableDates: [...unavailableDates] }
          : pack;
      }),
    };
  }
);

export const loadCoworkCustomerPasses = Effect.fn("cowork.loadCustomerPasses")(
  function* (restored: Parameters<typeof getCoworkBookingPasses>[2]) {
    const account = yield* CurrentCustomerAccount;
    const active = yield* Effect.option(account.requireActive);
    if (Option.isNone(active)) return visitorCoworkPasses;

    const { accountId, verifiedSignInAt } = active.value;
    const date = getCurrentWorkspaceDate();
    const today = plainDateStringSchema.make(date.toString());
    yield* recoverEntryPackGiftClaims(accountId, verifiedSignInAt);
    const [held, unlimitedPasses] = yield* Effect.all(
      [listHeldEntryPacks(accountId), listHeldUnlimitedPasses(accountId)],
      { concurrency: yield* workspaceStatementConcurrency }
    );
    const bookingPasses = yield* withUnlimitedCoveredDates(
      accountId,
      today,
      getCoworkBookingPasses(held, today, restored)
    );
    return {
      bookingPasses,
      passPurchaseOffered: !unlimitedPasses.some((pass) =>
        isCurrentUnlimitedPass(pass, date)
      ),
    } satisfies CoworkCustomerPasses;
  }
);
