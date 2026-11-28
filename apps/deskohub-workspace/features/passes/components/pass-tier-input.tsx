import { Clock, Coffee, KeyRound, Monitor, Wifi } from "lucide-react";
import Image from "next/image";
import { type ReactNode, useId } from "react";
import openSpaceArtwork from "@/features/cowork/assets/open-space.png";
import reservedDeskArtwork from "@/features/cowork/assets/reserved-desk.png";
import workstationArtwork from "@/features/cowork/assets/reserved-desk-workstation.png";
import { type Locale, m } from "@/features/i18n";
import {
  ReservationTypeInput,
  ReservationTypeOption,
} from "@/features/reservation/components/reservation-type-input";
import { workspaceSiteConstants } from "@/shared/utils/site-constants";
import { type PassProduct, type PassTier, passTiers } from "../pass-offer";
import { getPassTierName } from "../pass-offer.i18n";

const artwork = {
  "open-space": openSpaceArtwork,
  "reserved-desk": reservedDeskArtwork,
  "reserved-desk-workstation": workstationArtwork,
};

export function PassTierInput({
  locale,
  className,
  kind,
  tier,
  priceForTier,
  onChange,
}: {
  readonly locale: Locale;
  readonly className?: string;
  readonly kind: PassProduct["kind"];
  readonly tier: PassTier;
  readonly priceForTier: (tier: PassTier) => ReactNode;
  readonly onChange: (tier: PassTier) => void;
}) {
  const labelId = useId();
  const unlimited = kind === "unlimited";
  const { openSpaceUsableUntil: until } = workspaceSiteConstants.openingHours;
  return (
    <fieldset>
      <legend
        id={labelId}
        className="mb-1 font-semibold text-sm uppercase tracking-widest text-navy-blue/75"
      >
        {m.entryPackCheckoutWorkspace({}, { locale })}
      </legend>
      <ReservationTypeInput
        aria-labelledby={labelId}
        className={className}
        idPrefix={labelId}
        name="tier"
        presentation="illustrated"
        value={tier}
        values={passTiers}
        onChange={onChange}
      >
        {passTiers.map((option) => {
          const description = unlimited
            ? {
                "open-space": m.unlimitedPassDiscoveryOpenSpaceDescription(
                  { until },
                  { locale }
                ),
                "reserved-desk":
                  m.unlimitedPassDiscoveryReservedDeskDescription(
                    {},
                    { locale }
                  ),
                "reserved-desk-workstation":
                  m.unlimitedPassDiscoveryWorkstationDescription(
                    {},
                    { locale }
                  ),
              }[option]
            : {
                "open-space": m.reservationOpenSpaceBulletDesk(
                  { until },
                  { locale }
                ),
                "reserved-desk": m.reservationReservedDeskBulletDesk(
                  {},
                  { locale }
                ),
                "reserved-desk-workstation":
                  m.entryPackCheckoutWorkstationDescription({}, { locale }),
              }[option];
          const openSpace = option === "open-space";
          return (
            <ReservationTypeOption
              key={option}
              value={option}
              title={getPassTierName(option, locale)}
              price={priceForTier(option)}
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
              {openSpace && (
                <>
                  <span className="mb-2 flex items-center gap-2 text-sm text-navy-blue/75">
                    <Wifi size={16} />
                    {m.reservationOpenSpacePerkWifi({}, { locale })}
                  </span>
                  {!unlimited && (
                    <span className="mb-2 flex items-center gap-2 text-sm text-navy-blue/75">
                      <Clock size={16} />
                      {m.entryPackCheckoutFreeDesk({}, { locale })}
                    </span>
                  )}
                </>
              )}
              {!openSpace &&
                (unlimited ? (
                  <span className="mb-2 flex items-center gap-2 text-sm text-navy-blue/75">
                    <Coffee size={16} />
                    {m.reservationReservedDeskPerkCoffee({}, { locale })}
                  </span>
                ) : (
                  <>
                    <span className="mb-2 flex items-center gap-2 text-sm text-navy-blue/75">
                      <KeyRound size={16} />
                      {m.reservationReservedDeskPerkAccess({}, { locale })}
                    </span>
                    <span className="mb-2 flex items-center gap-2 text-sm text-navy-blue/75">
                      <Clock size={16} />
                      {m.entryPackCheckoutDeskAllDay({}, { locale })}
                    </span>
                  </>
                ))}
              {!unlimited && option === "reserved-desk-workstation" && (
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
  );
}
