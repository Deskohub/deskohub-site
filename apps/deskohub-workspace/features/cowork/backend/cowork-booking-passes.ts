import "server-only";

import { Effect, Option } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { CurrentCustomerAccount } from "@/features/account/backend/current-customer-account";
import { recoverEntryPackGiftClaims } from "@/features/passes/backend/entry-pack-gift";
import { listHeldEntryPacks } from "@/features/passes/backend/held-entry-packs";
import { listUnlimitedPassCoverageWindows } from "@/features/passes/backend/unlimited-pass-window";
import { getCurrentWorkspaceDate } from "@/features/reservation/reservation-date";
import { type PlainDate, plainDateStringSchema } from "@/shared/utils/temporal";
import {
  getCoworkBookingPasses,
  noCoworkBookingPasses,
} from "../cowork-entry-packs";

export const loadCoworkBookingPasses = Effect.fn("cowork.loadBookingPasses")(
  function* (restored: Parameters<typeof getCoworkBookingPasses>[2]) {
    const account = yield* CurrentCustomerAccount;
    const active = yield* Effect.option(account.requireActive);
    if (Option.isNone(active)) return noCoworkBookingPasses;

    const { accountId, verifiedSignInAt } = active.value;
    const today = plainDateStringSchema.make(
      getCurrentWorkspaceDate().toString()
    );
    yield* recoverEntryPackGiftClaims(accountId, verifiedSignInAt);
    const held = yield* listHeldEntryPacks(accountId);
    const booking = getCoworkBookingPasses(held, today, restored);
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
