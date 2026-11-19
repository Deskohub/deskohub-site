import { Clock, KeyRound, Monitor, Ticket, Wifi } from "lucide-react";
import Image from "next/image";
import {
  getWorkspaceProductByTier,
  workspaceProductWorkstationAddonPrice,
} from "@/features/checkout/product-catalog";
import openSpaceArtwork from "@/features/cowork/assets/open-space.png";
import reservedDeskArtwork from "@/features/cowork/assets/reserved-desk.png";
import workstationArtwork from "@/features/cowork/assets/reserved-desk-workstation.png";
import { type Locale, m } from "@/features/i18n";
import { ReservationFormCard } from "@/features/reservation/components/reservation-form-card";
import { ReservationSubmitSection } from "@/features/reservation/components/reservation-submit-section";
import {
  ReservationTypeInput,
  ReservationTypeOption,
} from "@/features/reservation/components/reservation-type-input";
import { currencyCZK } from "@/shared/money/currencies";
import { formatMoney } from "@/shared/money/money";
import {
  type EntryPackProduct,
  type EntryPackSize,
  entryPackOffers,
  type PassTier,
  passTiers,
} from "../pass-offer";

export const entryPackTierLabel = (tier: PassTier, locale: Locale) =>
  ({
    "open-space": m.passTierOpenSpace,
    "reserved-desk": m.passTierReservedDesk,
    "reserved-desk-workstation": m.passTierWorkstation,
  })[tier]({}, { locale });

export const formatEntryPackDate = (date: string, locale: Locale) =>
  new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));

const artwork = {
  "open-space": openSpaceArtwork,
  "reserved-desk": reservedDeskArtwork,
  "reserved-desk-workstation": workstationArtwork,
};

export function EntryPackChoose({
  locale,
  product,
  validity,
  onChange,
  onContinue,
}: {
  readonly locale: Locale;
  readonly product: EntryPackProduct;
  readonly validity: Partial<Record<EntryPackSize, string>>;
  readonly onChange: (product: EntryPackProduct) => void;
  readonly onContinue: () => void;
}) {
  const { tier, size } = product;
  const singleDayPrice =
    getWorkspaceProductByTier(tier === "open-space" ? tier : "reserved-desk")
      .price.value +
    (tier === "reserved-desk-workstation"
      ? workspaceProductWorkstationAddonPrice.value
      : 0);
  return (
    <ReservationFormCard>
      <form
        className="space-y-7"
        onSubmit={(event) => {
          event.preventDefault();
          onContinue();
        }}
      >
        <fieldset>
          <legend className="mb-1 font-semibold text-sm uppercase tracking-widest text-navy-blue/75">
            {m.entryPackCheckoutWorkspace({}, { locale })}
          </legend>
          <ReservationTypeInput
            idPrefix="entry-pack-tier"
            presentation="illustrated"
            value={tier}
            onChange={(next) => onChange({ ...product, tier: next })}
          >
            {passTiers.map((option) => {
              const price = currencyCZK(
                Math.min(
                  ...entryPackOffers
                    .filter((offer) => offer.product.tier === option)
                    .map((offer) => offer.price.value / offer.product.size)
                )
              );
              const description = {
                "open-space": m.reservationOpenSpaceBulletDesk(
                  { until: "17:00" },
                  { locale }
                ),
                "reserved-desk": m.reservationReservedDeskBulletDesk(
                  {},
                  { locale }
                ),
                "reserved-desk-workstation":
                  m.entryPackCheckoutWorkstationDescription({}, { locale }),
              }[option];
              return (
                <ReservationTypeOption
                  key={option}
                  value={option}
                  title={entryPackTierLabel(option, locale)}
                  price={m.entryPackCheckoutFromPerDay(
                    { price: formatMoney(price, locale) },
                    { locale }
                  )}
                  illustration={
                    <Image
                      alt=""
                      src={artwork[option]}
                      className="h-full w-full object-cover object-right-top"
                    />
                  }
                >
                  <span className="mb-12 block max-w-40 text-sm leading-5 text-navy-blue/75">
                    {description}
                  </span>
                  <span className="mb-2 flex items-center gap-2 text-sm text-navy-blue/75">
                    {option === "open-space" ? (
                      <Wifi size={16} />
                    ) : (
                      <KeyRound size={16} />
                    )}
                    {option === "open-space"
                      ? m.reservationOpenSpacePerkWifi({}, { locale })
                      : m.reservationReservedDeskPerkAccess({}, { locale })}
                  </span>
                  <span className="mb-2 flex items-center gap-2 text-sm text-navy-blue/75">
                    <Clock size={16} />
                    {option === "open-space"
                      ? m.entryPackCheckoutFreeDesk({}, { locale })
                      : m.entryPackCheckoutDeskAllDay({}, { locale })}
                  </span>
                  {option === "reserved-desk-workstation" && (
                    <span className="flex items-center gap-2 text-sm text-navy-blue/75">
                      <Monitor size={16} />
                      {m.entryPackCheckoutMonitors({}, { locale })}
                    </span>
                  )}
                </ReservationTypeOption>
              );
            })}
          </ReservationTypeInput>
        </fieldset>
        <fieldset>
          <legend className="mb-1 font-semibold text-sm uppercase tracking-widest text-navy-blue/75">
            {m.entryPackCheckoutSize(
              { tier: entryPackTierLabel(tier, locale) },
              { locale }
            )}
          </legend>
          <ReservationTypeInput
            className="lg:grid-cols-2"
            idPrefix="entry-pack-size"
            value={String(size)}
            onChange={(next) =>
              onChange({ ...product, size: next === "5" ? 5 : 10 })
            }
          >
            {entryPackOffers
              .filter((offer) => offer.product.tier === tier)
              .map((offer) => {
                const count = offer.product.size;
                const dayPrice = offer.price.value / count;
                const date = validity[count];
                return (
                  <ReservationTypeOption
                    key={count}
                    value={String(count)}
                    title={m.passEntryCount({ count }, { locale })}
                    price={formatMoney(offer.price, locale)}
                  >
                    <span className="block text-sm leading-6 text-navy-blue/75">
                      {date
                        ? m.entryPackCheckoutValidity(
                            {
                              months: offer.validityMonths,
                              date: formatEntryPackDate(date, locale),
                            },
                            { locale }
                          )
                        : m.entryPackCheckoutValidityMonths(
                            { months: offer.validityMonths },
                            { locale }
                          )}
                    </span>
                    <span className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm font-semibold">
                      {m.entryPackCheckoutPerDay(
                        { price: formatMoney(currencyCZK(dayPrice), locale) },
                        { locale }
                      )}
                      <span className="rounded-full bg-aquamarine-green/20 px-2.5 text-xs leading-5 text-aquamarine-ink">
                        {m.entryPackCheckoutSaving(
                          {
                            price: formatMoney(
                              currencyCZK(singleDayPrice - dayPrice),
                              locale
                            ),
                          },
                          { locale }
                        )}
                      </span>
                    </span>
                  </ReservationTypeOption>
                );
              })}
          </ReservationTypeInput>
        </fieldset>
        <p className="flex items-start gap-2 text-sm leading-6 text-navy-blue/75">
          <Ticket
            aria-hidden="true"
            className="mt-1 shrink-0 text-burned-orange"
            size={16}
          />
          {m.entryPackCheckoutUseNote({}, { locale })}
        </p>
        <EntryPackContinue locale={locale} />
      </form>
    </ReservationFormCard>
  );
}

export function EntryPackContinue({
  locale,
  pending = false,
}: {
  readonly locale: Locale;
  readonly pending?: boolean;
}) {
  return (
    <ReservationSubmitSection
      continues
      disabled={pending}
      isAvailabilityLoading={false}
      isPriceLoading={false}
      locale={locale}
      onRetryPrice={() => {}}
      priceError={false}
      retryingPrice={false}
    />
  );
}
