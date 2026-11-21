import "server-only";

import { getCustomerDisplayName } from "@deskohub/dotypos";
import { and, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { cache } from "react";
import { WorkspaceDatabase } from "@/db/database.service";
import { orders, passPurchases } from "@/db/schema";
import { CurrentCustomerAccount } from "@/features/account/backend/current-customer-account";
import { findEntryPackPurchasePartyContacts } from "@/features/account/backend/customer-account-by-email";
import { CustomerProfileService } from "@/features/account/backend/customer-profile.service";
import type { CustomerAccountId } from "@/features/account/customer-account";
import type { Locale } from "@/features/i18n";
import type { OrderId } from "@/features/order";
import {
  type EntryPackGiftState,
  readEntryPackGiftStates,
  recoverEntryPackGiftClaims,
} from "@/features/passes/backend/entry-pack-gift";
import {
  getHeldEntryPackStatus,
  type HeldEntryPack,
  listHeldEntryPacks,
} from "@/features/passes/backend/held-entry-packs";
import {
  type EntryPackProduct,
  type EntryPackSize,
  getEntryPackLastUsableDate,
  type UnlimitedPassProduct,
} from "@/features/passes/pass-offer";
import { getPassTierName } from "@/features/passes/pass-offer.i18n";
import {
  getCoworkReservationPath,
  reservationStatusPath,
} from "@/features/reservation/routes";
import {
  catchRecoverableCause,
  runWorkspaceEffectOrElse,
} from "@/shared/backend/workspace-effect";
import { maskEmailAddress } from "@/shared/utils";
import {
  formatInstantDate,
  formatPlainDate,
} from "@/shared/utils/date-time-format";
import { workspaceSiteConstants } from "@/shared/utils/site-constants";
import { currentPlainDate, type PlainDate } from "@/shared/utils/temporal";

export type AccountEntryPack = {
  readonly position: number;
  readonly tier: string;
  readonly entryCount: number;
  readonly entriesLeft: number;
  readonly boughtOn?: string;
  readonly lastUsableDay: string;
  readonly status: "active" | "expired" | "depleted" | "ended";
  readonly bookPath?: string;
  readonly gift?: {
    readonly orderId: OrderId;
    readonly buyerName?: string;
  };
};

export type AccountBoughtPass = Omit<EntryPackGiftState, "canResend"> & {
  readonly orderId: OrderId;
  readonly statusPath: string;
  readonly tier: string;
  readonly maskedHolderEmail?: string;
} & (
    | {
        readonly product: "entry-pack";
        readonly entryCount: EntryPackSize;
        readonly canResend: boolean;
      }
    | { readonly product: "unlimited" }
  );

export type AccountPasses =
  | {
      readonly held: readonly AccountEntryPack[];
      readonly boughtForOthers: readonly AccountBoughtPass[];
    }
  | "unavailable";

const timeZone = workspaceSiteConstants.location.timeZone;

export const loadAccountPasses = Effect.fn("loadAccountPasses")(function* (
  locale: Locale,
  profileLayer: Layer.Layer<
    CustomerProfileService,
    unknown
  > = CustomerProfileService.Live
) {
  const account = yield* CurrentCustomerAccount;
  const standing = yield* account.peek;
  if (standing.kind === "review")
    return { held: [], boughtForOthers: [] } as const;
  if (
    (standing.kind !== "linked" && standing.kind !== "unlinked") ||
    standing.reviewMarker !== "absent"
  ) {
    return "unavailable" as const;
  }

  const { accountId, verifiedSignInAt } = standing.session;
  yield* recoverEntryPackGiftClaims(accountId, verifiedSignInAt);
  const [packs, today, boughtForOthers] = yield* Effect.all(
    [
      listHeldEntryPacks(accountId),
      currentPlainDate(timeZone),
      listBoughtGifts(accountId, locale),
    ],
    { concurrency: "unbounded" }
  );
  const giftBuyers = yield* readHeldPassGiftBuyers(
    accountId,
    packs.map(({ id }) => id),
    profileLayer
  );
  return {
    held: packs.map((pack, position) => ({
      ...toAccountEntryPack(pack, position, today, locale),
      gift: giftBuyers.has(pack.id)
        ? { orderId: pack.id, buyerName: giftBuyers.get(pack.id) }
        : undefined,
    })),
    boughtForOthers,
  };
});

const listBoughtGifts = Effect.fn("listBoughtPassGifts")(function* (
  accountId: CustomerAccountId,
  locale: Locale
) {
  const gifts = yield* readBoughtPassGifts(accountId);
  return gifts.map(
    ({ orderId, product, canResend, ...gift }): AccountBoughtPass => {
      const summary = {
        ...gift,
        orderId,
        statusPath: `/${locale}${reservationStatusPath}/${orderId}`,
        tier: getPassTierName(product.tier, locale),
      };
      return product.kind === "unlimited"
        ? { ...summary, product: "unlimited" }
        : {
            ...summary,
            product: "entry-pack",
            entryCount: product.size,
            canResend,
          };
    }
  );
});

type BoughtPassGift = EntryPackGiftState & {
  readonly orderId: OrderId;
  readonly product: EntryPackProduct | UnlimitedPassProduct;
  readonly maskedHolderEmail?: string;
};

export const readBoughtPassGifts = Effect.fn("readBoughtPassGifts")(function* (
  accountId: CustomerAccountId
) {
  const { db } = yield* WorkspaceDatabase;
  const gifts = yield* db
    .select({
      orderId: passPurchases.id,
      holderAccountId: passPurchases.holderAccountId,
      tier: passPurchases.tier,
      product: passPurchases.product,
      entryCount: passPurchases.entryCount,
    })
    .from(passPurchases)
    .innerJoin(orders, eq(orders.id, passPurchases.id))
    .where(
      and(
        eq(passPurchases.buyerAccountId, accountId),
        ne(passPurchases.holderAccountId, accountId),
        eq(orders.kind, "pass-purchase"),
        eq(orders.paymentState, "paid"),
        isNotNull(orders.paidAt)
      )
    )
    .orderBy(desc(orders.paidAt), desc(passPurchases.id));
  if (gifts.length === 0) return [];

  const recipientIds = [...new Set(gifts.map((gift) => gift.holderAccountId))];
  const [states, recipients] = yield* Effect.all(
    [
      readEntryPackGiftStates(gifts.map((gift) => gift.orderId)),
      findEntryPackPurchasePartyContacts(recipientIds),
    ],
    { concurrency: "unbounded" }
  );
  const result: BoughtPassGift[] = [];
  for (const { orderId, tier, product, entryCount, holderAccountId } of gifts) {
    const state = states.get(orderId);
    // A refund can end payment eligibility between the two reads.
    if (!state) continue;
    const email = recipients.get(holderAccountId)?.email;
    const masked = email ? maskEmailAddress(email) : undefined;
    const maskedHolderEmail = masked === email ? undefined : masked;
    const summary = {
      ...state,
      orderId,
      maskedHolderEmail,
      canResend: state.canResend && maskedHolderEmail !== undefined,
    };
    if (product === "unlimited")
      result.push({ ...summary, product: { kind: product, tier } });
    else if (entryCount !== null)
      result.push({
        ...summary,
        product: { kind: product, tier, size: entryCount },
      });
  }
  return result;
});

export const readHeldPassGiftBuyers = Effect.fn("readHeldPassGiftBuyers")(
  function* (
    holderAccountId: CustomerAccountId,
    heldIds: readonly OrderId[],
    profileLayer: Layer.Layer<
      CustomerProfileService,
      unknown
    > = CustomerProfileService.Live
  ) {
    if (heldIds.length === 0) return new Map<OrderId, string | undefined>();
    const { db } = yield* WorkspaceDatabase;
    const gifts = yield* db
      .select({
        orderId: passPurchases.id,
        accountId: passPurchases.buyerAccountId,
      })
      .from(passPurchases)
      .innerJoin(orders, eq(orders.id, passPurchases.id))
      .where(
        and(
          eq(passPurchases.holderAccountId, holderAccountId),
          eq(orders.paymentState, "paid"),
          ne(passPurchases.buyerAccountId, holderAccountId),
          inArray(passPurchases.id, heldIds)
        )
      );
    const buyers = yield* findEntryPackPurchasePartyContacts(
      gifts.map((gift) => gift.accountId)
    );
    const linkedBuyers = [...buyers].flatMap(
      ([accountId, { dotyposCustomerId }]) =>
        dotyposCustomerId ? [{ accountId, dotyposCustomerId }] : []
    );
    const profileNames = new Map(
      linkedBuyers.length === 0
        ? []
        : yield* Effect.gen(function* () {
            const profiles = yield* CustomerProfileService;
            return yield* Effect.forEach(
              linkedBuyers,
              (buyer) =>
                profiles.load(buyer).pipe(
                  Effect.map(({ firstName, lastName }) => {
                    const name = getCustomerDisplayName({
                      firstName,
                      lastName,
                    });
                    return name?.includes("@") ? undefined : name;
                  }),
                  catchRecoverableCause(() => Effect.succeed(undefined)),
                  Effect.map((name) => [buyer.accountId, name] as const)
                ),
              { concurrency: 4 }
            );
          }).pipe(
            Effect.provide(profileLayer),
            catchRecoverableCause(() => Effect.succeed([]))
          )
    );
    return new Map(
      gifts.map(({ orderId, accountId }) => [
        orderId,
        profileNames.get(accountId),
      ])
    );
  }
);

export const loadCustomerAccountPasses = cache(
  (locale: Locale): Promise<AccountPasses> =>
    loadAccountPasses(locale).pipe(
      Effect.provide(
        Layer.mergeAll(CurrentCustomerAccount.Live, WorkspaceDatabase.Default)
      ),
      runWorkspaceEffectOrElse("account.passes", {
        boundary: "page",
        failureCode: "account.passes.unavailable",
        orElse: () => "unavailable" as const,
      })
    )
);

function toAccountEntryPack(
  pack: HeldEntryPack,
  position: number,
  today: PlainDate,
  locale: Locale
): AccountEntryPack {
  const status = getHeldEntryPackStatus(pack, today);

  return {
    position,
    tier: getPassTierName(pack.tier, locale),
    entryCount: pack.entryCount,
    entriesLeft: pack.entriesLeft,
    ...(!pack.complimentary && {
      boughtOn: formatInstantDate({ instant: pack.paidAt, locale, timeZone }),
    }),
    lastUsableDay: formatPlainDate({
      date: getEntryPackLastUsableDate(pack.validUntil),
      locale,
    }),
    status,
    ...(status === "active" &&
      pack.entriesLeft > 0 &&
      (pack.giftIssuedAt === null || pack.giftClaimedAt !== null) &&
      pack.giftPaymentIsUsable && {
        bookPath: `${getCoworkReservationPath(locale)}?${new URLSearchParams({ pass: pack.id })}`,
      }),
  };
}
