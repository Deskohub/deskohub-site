import { getAccountSignInPath } from "@/features/account/routes";
import { m } from "@/features/i18n";
import type { OrderId } from "@/features/order";
import { formatMoney, moneyWithValue } from "@/shared/money/money";
import { getUnlimitedPassPrice, unlimitedPassCoffeePrice } from "../pass-offer";
import { formatPassDate, getPassTierName } from "../pass-offer.i18n";
import type { UnlimitedPassSelection } from "../unlimited-pass";
import { getUnlimitedPassDetailsPath } from "../unlimited-pass-checkout";
import {
  PassPurchaseDetails,
  type PassPurchaseDetailsProps,
  PassPurchaseSummaryItem,
} from "./pass-purchase-details";

export function UnlimitedPassDetails({
  selection,
  orderId,
  ...props
}: PassPurchaseDetailsProps & {
  readonly selection: UnlimitedPassSelection;
  readonly orderId?: OrderId;
}) {
  const { locale } = props;
  const passPrice = getUnlimitedPassPrice({
    kind: "unlimited",
    tier: selection.tier,
  });
  const total =
    selection.tier === "open-space" && selection.coffee
      ? moneyWithValue(
          passPrice.value + unlimitedPassCoffeePrice.value,
          passPrice
        )
      : passPrice;
  return (
    <PassPurchaseDetails
      {...props}
      signInNote={m.unlimitedPassCheckoutSignInNote({}, { locale })}
      signInPath={getAccountSignInPath(
        locale,
        getUnlimitedPassDetailsPath(locale, selection, orderId)
      )}
      summaryTitle={m.passUnlimited({}, { locale })}
      summary={
        <>
          <PassPurchaseSummaryItem
            label={m.entryPackCheckoutWorkspace({}, { locale })}
            value={getPassTierName(selection.tier, locale)}
          />
          <PassPurchaseSummaryItem
            label={m.unlimitedPassCheckoutStartDate({}, { locale })}
            value={formatPassDate(selection.startDate, locale)}
          />
          <PassPurchaseSummaryItem
            label={m.entryPackCheckoutPrice({}, { locale })}
            value={formatMoney(total, locale)}
          />
        </>
      }
    />
  );
}
