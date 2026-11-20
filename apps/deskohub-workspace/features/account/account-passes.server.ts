import "server-only";

import { Effect, Layer } from "effect";
import { cache } from "react";
import { WorkspaceDatabase } from "@/db/database.service";
import { CurrentCustomerAccount } from "@/features/account/backend/current-customer-account";
import type { Locale } from "@/features/i18n";
import {
  type HeldEntryPack,
  listHeldEntryPacks,
} from "@/features/passes/backend/held-entry-packs";
import { getEntryPackLastUsableDate } from "@/features/passes/pass-offer";
import { getPassTierName } from "@/features/passes/pass-offer.i18n";
import { getCoworkReservationPath } from "@/features/reservation/routes";
import { runWorkspaceEffectOrElse } from "@/shared/backend/workspace-effect";
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
  readonly boughtOn: string;
  readonly lastUsableDay: string;
  readonly status: "active" | "expired" | "depleted" | "ended";
  readonly bookPath?: string;
};

export type AccountPasses = readonly AccountEntryPack[] | "unavailable";

const timeZone = workspaceSiteConstants.location.timeZone;

export const loadAccountPasses = Effect.fn("loadAccountPasses")(function* (
  locale: Locale
) {
  const account = yield* CurrentCustomerAccount;
  const standing = yield* account.peek;
  if (standing.kind === "review") return [] as const;
  if (
    (standing.kind !== "linked" && standing.kind !== "unlinked") ||
    standing.reviewMarker !== "absent"
  ) {
    return "unavailable" as const;
  }

  const [packs, today] = yield* Effect.all([
    listHeldEntryPacks(standing.session.accountId),
    currentPlainDate(timeZone),
  ]);
  return packs.map((pack, position) =>
    toAccountEntryPack(pack, position, today, locale)
  );
});

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

const getAccountPassStatus = (
  pack: HeldEntryPack,
  today: PlainDate
): AccountEntryPack["status"] => {
  switch (pack.status) {
    case "active":
      return Temporal.PlainDate.compare(today, pack.validUntil) >= 0
        ? "expired"
        : "active";
    case "depleted":
    case "expired":
      return pack.status;
    case "pending_payment":
    case "cancelled":
    case "withdrawn":
    case "void":
      return "ended";
  }
};

function toAccountEntryPack(
  pack: HeldEntryPack,
  position: number,
  today: PlainDate,
  locale: Locale
): AccountEntryPack {
  const status = getAccountPassStatus(pack, today);

  return {
    position,
    tier: getPassTierName(pack.tier, locale),
    entryCount: pack.entryCount,
    entriesLeft: pack.entriesLeft,
    boughtOn: formatInstantDate({ instant: pack.paidAt, locale, timeZone }),
    lastUsableDay: formatPlainDate({
      date: getEntryPackLastUsableDate(pack.validUntil),
      locale,
    }),
    status,
    ...(status === "active" &&
      pack.entriesLeft > 0 && {
        bookPath: `${getCoworkReservationPath(locale)}?${new URLSearchParams({ pass: pack.id })}`,
      }),
  };
}
