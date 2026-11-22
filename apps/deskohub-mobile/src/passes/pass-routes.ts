import { Option } from "effect";
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

export const entryPackHrefForDraft = (draft: CoworkDraft) => {
  const workstation = Option.getOrUndefined(draft.workstation);
  return {
    pathname: entryPackPurchaseHref,
    params: {
      tier: coworkPassTier(draft),
      ...(draft.tier === "reserved-desk" &&
        workstation !== undefined && {
          monitorOption: workstation.option,
        }),
    },
  } as const;
};
