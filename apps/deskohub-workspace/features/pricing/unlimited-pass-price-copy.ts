import { type Locale, m } from "@/features/i18n";
import {
  type PassTier,
  unlimitedPassCoffeePrice,
} from "@/features/passes/pass-offer";
import { currencyCZK } from "@/shared/money/currencies";
import {
  formatMoney,
  type Money,
  moneyMajorAmount,
} from "@/shared/money/money";
import { workspaceSiteConstants } from "@/shared/utils/site-constants";

export function getUnlimitedPassPriceCopy(
  tier: PassTier,
  price: Money,
  days: number,
  locale: Locale
) {
  return {
    period: m.unlimitedPassDiscoveryPrice(
      { price: formatMoney(price, locale), days },
      { locale }
    ),
    perDay: m.unlimitedPassDiscoveryPerDay(
      {
        price: formatMoney(
          currencyCZK(Math.round(moneyMajorAmount(price) / days) * 100),
          locale
        ),
      },
      { locale }
    ),
    description: {
      "open-space": m.unlimitedPassDiscoveryOpenSpaceDescription(
        { until: workspaceSiteConstants.openingHours.openSpaceUsableUntil },
        { locale }
      ),
      "reserved-desk": m.unlimitedPassDiscoveryReservedDeskDescription(
        {},
        { locale }
      ),
      "reserved-desk-workstation":
        m.unlimitedPassDiscoveryWorkstationDescription({}, { locale }),
    }[tier],
    coffee:
      tier === "open-space"
        ? m.unlimitedPassDiscoveryCoffee(
            { price: formatMoney(unlimitedPassCoffeePrice, locale) },
            { locale }
          )
        : m.reservationReservedDeskPerkCoffee({}, { locale }),
  };
}
