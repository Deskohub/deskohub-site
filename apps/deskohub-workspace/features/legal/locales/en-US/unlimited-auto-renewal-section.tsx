import type { LegalSection } from "../../legal-document-body";
import { contactEmail } from "../operator-details";

export const unlimitedAutoRenewalSection: LegalSection = {
  heading: "16. Automatic renewal of Unlimited memberships",
  body: [
    "16.1 Automatic renewal is available only to Clients buying an Unlimited membership for their own use. Membership provides the agreed services in consecutive periods of 30 calendar days in the Europe/Prague time zone. With renewal selected, the contract continues indefinitely with no further minimum commitment. Without this choice, access ends when the paid period ends.",
    <>
      16.2 The current prices are listed on the{" "}
      <a
        className="text-burned-orange underline underline-offset-4"
        href="/en-US/pricing"
        hrefLang="en-US"
      >
        Pricing page
      </a>
      . Under section 5.2, the binding price for each renewal is the final
      recurring amount shown in the order summary immediately before submission,
      including any selected recurring add-ons. Reserved Desk tiers include
      coffee. Open Space coffee is available as a recurring add-on. Promotions,
      discount codes, and referral discounts apply only to the first period. A
      first order discounted by 100% to zero cannot renew automatically.
    </>,
    "16.3 The Client pays for the first period at checkout. Before submitting the order, the Client sees the selected tier and services, the first day of access, the amount due now, the next charge date, and the recurring amount. Renewal is charged at the start of the next period at 00:00 Prague time. For example, a period starting on 1 December covers 1 through 30 December, and the next period begins on 31 December. For business purchases, the Provider automatically issues an invoice for each paid renewal using the saved billing details. For changes to appear on the next invoice, the Client must update the details in the Billing & Invoices section of their Account before 00:00 Prague time on the scheduled renewal date.",
    "16.4 The Client authorizes future card charges with a separate checkbox that starts unchecked. The authorization allows the Provider to charge the agreed amount every 30 calendar days until renewal is cancelled. The first card payment and any required authentication take place with Nexi. The Provider uses a payment reference for later charges. Confirmation on a durable medium includes the accepted terms, authorization, amount, dates, and cancellation instructions.",
    "16.5 Seven calendar days before each scheduled charge, the Provider emails the Client the charge date and amount, the next service period, the 00:00 Prague time cancellation deadline on the renewal date, and a direct link to manage renewal. This is a service message sent independently of marketing consent.",
    <>
      16.6 The Client can stop renewal free of charge in the Packs and
      memberships section of their Account or by sending an unequivocal notice
      to{" "}
      <a
        className="text-burned-orange underline underline-offset-4"
        href={`mailto:${contactEmail}`}
      >
        {contactEmail}
      </a>
      . To prevent the next charge, cancellation must take effect before 00:00
      Prague time (Europe/Prague) on the scheduled renewal date. In the Account,
      cancellation takes effect immediately upon submission; for email to{" "}
      {contactEmail}, the timestamp of receipt in the Europe/Prague time zone is
      decisive. If a timely notice is processed only after a renewal charge has
      already been initiated, the Provider cancels the renewed period and
      refunds that renewal charge in full without undue delay. The Provider
      confirms cancellation without undue delay, initiates no further renewal
      charges after cancellation, and access continues through the end of the
      paid period.
    </>,
    "16.7 The Provider secures capacity for the entire next period before charging. If the agreed service or the specific Reserved Desk cannot be provided, the Provider asks the Client to agree to a suitable alternative or stops renewal without charging for the next period. A different price, a change to a recurring add-on, or a material service change requires the Client's fresh agreement before charging. If the Client buys another Unlimited membership for their own use that covers the scheduled renewal date, the earlier membership stops renewing. Entry packs and memberships bought as gifts for someone else leave the earlier renewal in place. If the earlier membership is still charged for that renewal, the Provider cancels the duplicate renewal period and refunds the charge in full without undue delay. The new membership renews automatically only if the Client authorizes it separately at checkout.",
    <>
      16.8 If a renewal payment fails, the Provider informs the Client and
      offers a new checkout. The Provider does not retry the unsuccessful charge
      automatically. If the next period is unpaid, access ends when the paid
      period ends. To replace a card, including one that is about to expire, the
      Client must stop renewal and place a new order with the new card. During a
      paid membership period, Open Space is available each day from 00:00 to
      17:00 Prague time and Reserved Desk is available around the clock. The
      Client must use the current access PIN, which changes daily. The Client
      may leave belongings at their assigned Reserved Desk overnight while paid
      access continues and must remove them when that access ends, including if
      renewal fails. If anything is left behind, the Client can arrange
      collection by writing to{" "}
      <a
        className="text-burned-orange underline underline-offset-4"
        href={`mailto:${contactEmail}`}
      >
        {contactEmail}
      </a>
      . The Provider assumes no additional responsibility for loss of or damage
      to belongings left behind beyond the duties of care and liability that
      apply under Czech law.
    </>,
    "16.9 The Consumer's right to withdraw from the contract is governed by section 9 and applicable law. Starting service during the withdrawal period requires a separate express request where the statutory right applies. A valid statutory withdrawal stops automatic renewal. Under section 9.7, where the law permits a proportional charge, the Provider refunds the price actually paid for the period multiplied by the unused whole calendar days and divided by 30, rounded down to whole Czech crowns. The withdrawal day counts as used if service has started, and the Consumer keeps access through the end of that day.",
  ],
};
