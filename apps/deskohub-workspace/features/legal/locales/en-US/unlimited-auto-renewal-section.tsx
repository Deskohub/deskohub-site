import type { LegalSection } from "../../legal-document-body";
import { contactEmail } from "../operator-details";

export const unlimitedAutoRenewalSection: LegalSection = {
  heading: "16. Automatic renewal of Unlimited memberships (draft)",
  body: [
    "16.1 This section is a preview draft. It is not in force and recurring charges are disabled. Nexi must enable recurring payments for the Provider before launch.",
    "16.2 Automatic renewal is available only to Clients buying Unlimited for their own use. Membership provides the agreed services in consecutive periods of 30 calendar days in the Europe/Prague time zone. With renewal selected, the contract continues indefinitely with no further minimum commitment. Without this choice, access ends when the paid period ends.",
    "16.3 The final price for each 30-day period is CZK 3,490 for Open Space, CZK 5,990 for Reserved Desk, or CZK 8,490 for Reserved Desk + workstation. Open Space coffee costs CZK 690 per period when selected. Reserved Desk tiers include coffee. Entry packs are purchased separately with a one-time payment.",
    "16.4 The first period is paid at checkout. Before submitting the order, the Client sees the selected tier and services, the first day of access, the amount due now, the next charge date, and the exact amount of each renewal including selected recurring add-ons. Renewal is charged at the start of the next period at 00:00 Prague time. For example, a period starting on 1 December covers 1 through 30 December, and the next period begins on 31 December.",
    "16.5 The Client authorizes future card charges with a separate checkbox that starts unchecked. The authorization allows the Provider to charge the agreed amount every 30 calendar days until renewal is cancelled. The first card payment and any required authentication take place with Nexi. The Provider uses a payment reference for later charges. Confirmation on a durable medium includes the accepted terms, authorization, amount, dates, and cancellation instructions.",
    "16.6 Seven calendar days before each scheduled charge, the Provider emails the Client the charge date and amount, the next service period, and a direct link to manage renewal. This is a service message sent independently of marketing consent.",
    <>
      16.7 The Client can stop renewal free of charge in the Passes section of
      their Account or by sending an unequivocal notice to{" "}
      <a
        className="text-burned-orange underline underline-offset-4"
        href={`mailto:${contactEmail}`}
      >
        {contactEmail}
      </a>
      . Stop renewal before the next scheduled charge at 00:00 Prague time. The
      Provider confirms cancellation without undue delay. The Provider initiates
      no further renewal charges after cancellation, and access continues
      through the end of the paid period.
    </>,
    "16.8 The Provider secures capacity for the entire next period before charging. If the agreed service or Reserved Desk cannot be provided, the Provider seeks consent to a suitable alternative or stops renewal without charging for a new period. A different price, a change to a recurring add-on, or a material service change requires the Client's fresh agreement before charging.",
    "16.9 If a renewal payment fails, the Provider informs the Client and offers a new checkout. The Provider will not retry the unsuccessful charge automatically. If the next period is unpaid, access ends when the paid period ends.",
    "16.10 Stopping renewal cancels future charges. The Consumer's right to withdraw from the contract is governed separately by section 9 and applicable law. Where the right applies, starting service during the withdrawal period requires a separate express request. If the Consumer withdraws after service starts, the Provider may charge proportionately for service already supplied if the statutory conditions are met.",
  ],
};
