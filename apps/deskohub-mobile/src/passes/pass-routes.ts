import type { CoworkDraft } from "../booking/selection/cowork-selection";
import { coworkPassTier } from "./entry-pack-booking";

export const entryPackPurchaseHref = "/passes/entry-pack" as const;
export const unlimitedPurchaseHref = "/passes/unlimited" as const;

export const bookWithEntryPackHref = (passId: string) =>
  ({
    pathname: "/book/cowork",
    params: { passId },
  }) as const;

export const unlimitedAccessHref = (passId: string) =>
  `/passes/access/${encodeURIComponent(passId)}` as const;

export const entryPackHrefForDraft = (draft: CoworkDraft) =>
  ({
    pathname: entryPackPurchaseHref,
    params: { tier: coworkPassTier(draft) },
  }) as const;
