import { Option, Schema } from "effect";
import {
  type WorkspaceProductMonitorOption,
  workspaceProductMonitorOptions,
} from "@/features/checkout/product-catalog";
import type { Locale } from "@/features/i18n";
import type { OrderId } from "@/features/order";
import { type PlainDate, plainDateStringSchema } from "@/shared/utils/temporal";
import { type PassTier, passTiers } from "./pass-offer";
import { unlimitedPassCheckoutPath } from "./routes";
import type { UnlimitedPassSelection } from "./unlimited-pass";

export type UnlimitedPassOptions =
  | Omit<Extract<UnlimitedPassSelection, { tier: "open-space" }>, "startDate">
  | Omit<
      Extract<UnlimitedPassSelection, { tier: "reserved-desk" }>,
      "startDate"
    >
  | Omit<
      Extract<UnlimitedPassSelection, { tier: "reserved-desk-workstation" }>,
      "startDate"
    >;

export type UnlimitedPassStartDates = {
  readonly "open-space": readonly PlainDate[];
  readonly "reserved-desk": readonly PlainDate[];
  readonly "reserved-desk-workstation": Readonly<
    Record<WorkspaceProductMonitorOption, readonly PlainDate[]>
  >;
};

const decodeStartDate = Schema.decodeUnknownOption(plainDateStringSchema);

export function unlimitedPassOptionsForTier(
  tier: PassTier
): UnlimitedPassOptions {
  switch (tier) {
    case "open-space":
      return { tier, coffee: false };
    case "reserved-desk":
      return { tier };
    case "reserved-desk-workstation":
      return { tier, monitorOption: workspaceProductMonitorOptions[0] };
  }
}

export function readUnlimitedPassSelection(query: {
  readonly tier?: string | string[];
  readonly startDate?: string | string[];
  readonly coffee?: string | string[];
  readonly monitorOption?: string | string[];
}): { readonly options: UnlimitedPassOptions; readonly startDate?: PlainDate } {
  const options = unlimitedPassOptionsForTier(
    passTiers.find((tier) => tier === query.tier) ?? "reserved-desk"
  );
  const startDate = Option.getOrUndefined(decodeStartDate(query.startDate));
  if (options.tier === "open-space") {
    return {
      options: { ...options, coffee: query.coffee === "true" },
      startDate,
    };
  }
  if (options.tier === "reserved-desk-workstation") {
    return {
      options: {
        ...options,
        monitorOption:
          workspaceProductMonitorOptions.find(
            (option) => option === query.monitorOption
          ) ?? options.monitorOption,
      },
      startDate,
    };
  }
  return { options, startDate };
}

export function getUnlimitedPassChoosePath(
  locale: Locale,
  options: UnlimitedPassOptions,
  startDate?: PlainDate
) {
  const query = new URLSearchParams({
    tier: options.tier,
    ...(startDate !== undefined && { startDate }),
    ...(options.tier === "open-space" && options.coffee && { coffee: "true" }),
    ...(options.tier === "reserved-desk-workstation" && {
      monitorOption: options.monitorOption,
    }),
  });
  return `/${locale}${unlimitedPassCheckoutPath}?${query}`;
}

export function getUnlimitedPassDetailsPath(
  locale: Locale,
  selection: UnlimitedPassSelection,
  orderId?: OrderId
) {
  const path = getUnlimitedPassChoosePath(
    locale,
    selection,
    selection.startDate
  );
  return `${path}&step=details${orderId !== undefined ? `&order=${orderId}` : ""}`;
}

export function getUnlimitedPassPayPath(locale: Locale, orderId: OrderId) {
  const query = new URLSearchParams({ order: orderId, step: "pay" });
  return `/${locale}${unlimitedPassCheckoutPath}?${query}`;
}

export function availableUnlimitedPassStarts(
  starts: UnlimitedPassStartDates,
  options: UnlimitedPassOptions
) {
  return options.tier === "reserved-desk-workstation"
    ? starts[options.tier][options.monitorOption]
    : starts[options.tier];
}
