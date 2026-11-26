import { type Locale, m } from "@/features/i18n";
import { offersUnlimitedAutoRenewal } from "@/features/passes/backend/unlimited-auto-renewal";
import {
  unlimitedPassDays,
  unlimitedPassOffers,
} from "@/features/passes/pass-offer";
import { getPassTierName } from "@/features/passes/pass-offer.i18n";
import { getUnlimitedPassPriceCopy } from "../unlimited-pass-price-copy";
import { UnlimitedPassPurchaseButton } from "./unlimited-pass-purchase-button";

export function UnlimitedPassPrices({ locale }: { readonly locale: Locale }) {
  return (
    <section
      aria-labelledby="pricing-unlimited-title"
      className="mt-14"
      id="pricing-unlimited"
    >
      <h2 id="pricing-unlimited-title" className="text-2xl sm:text-3xl">
        {m.passUnlimited({}, { locale })}
      </h2>
      <p className="mt-3 text-base leading-7 text-white/76">
        {m.unlimitedPassDiscoveryIntro({}, { locale })}
      </p>
      {offersUnlimitedAutoRenewal(locale) && (
        <p className="mt-3 text-base leading-7 text-white/76">
          {m.unlimitedPassDiscoveryAutoRenewal(
            { days: unlimitedPassDays },
            { locale }
          )}
        </p>
      )}
      <ul className="mt-5 divide-y divide-white/14 border-y border-white/14">
        {unlimitedPassOffers.map(
          ({ product: { tier }, price, validityDays }) => {
            const name = getPassTierName(tier, locale);
            const copy = getUnlimitedPassPriceCopy(
              tier,
              price,
              validityDays,
              locale
            );
            return (
              <li
                key={tier}
                className="grid gap-4 py-6 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-8"
              >
                <div className="min-w-0">
                  <h3 className="text-xl font-semibold first-letter:uppercase">
                    {name}
                  </h3>
                  <p className="mt-2 text-base leading-7 text-white/76">
                    {copy.description}
                  </p>
                  <p className="mt-3 text-base leading-7 text-white/86">
                    {copy.coffee}
                  </p>
                </div>
                <div className="flex flex-col items-start sm:items-end sm:text-right">
                  <p className="text-2xl font-semibold text-sunset-yellow">
                    {copy.period}
                  </p>
                  <p className="text-sm leading-6 text-white/76">
                    {copy.perDay}
                  </p>
                  <UnlimitedPassPurchaseButton
                    aria-label={m.unlimitedPassDiscoveryBuyTier(
                      { tier: name },
                      { locale }
                    )}
                    locale={locale}
                    tier={tier}
                  >
                    {m.entryPackDiscoveryBuy({}, { locale })}
                  </UnlimitedPassPurchaseButton>
                </div>
              </li>
            );
          }
        )}
      </ul>
    </section>
  );
}
