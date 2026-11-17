// PROTOTYPE ONLY (#1361): the buyer's purchase confirmation for an Entry pack
// or Unlimited. Not wired to any sender.
import { Link } from "react-email";
import {
  WorkspaceEmailBody,
  WorkspaceEmailHeading,
  WorkspaceEmailNote,
} from "@/emails/_components/workspace-email-content";

import { WorkspaceEmailLayout } from "@/emails/_components/workspace-email-layout";
import type { Locale } from "@/features/i18n";
import {
  ENTRY_PACK_PRICES,
  formatCzk,
  formatPrototypeDate,
  type PrototypePass,
  tierByKey,
  UNLIMITED_COFFEE_PRICE,
  UNLIMITED_PRICES,
} from "@/features/passes/prototype/mock-passes";
import { formatPeriod } from "../holder-mock";
import {
  PassEmailAction,
  PassEmailDetails,
  PassEmailCallout,
  PassEmailHero,
  PassEmailPriceTable,
} from "./pass-email-parts";

export type PurchaseConfirmationEmailProps = {
  readonly accountUrl: string;
  readonly locale: Locale;
  readonly pass: PrototypePass;
  readonly refundTermsUrl: string;
};

const firstName = (name: string) => name.split(" ")[0] ?? name;

const formatDateTime = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Prague",
  }).format(new Date(iso));

export const purchaseConfirmationSubject = ({
  pass,
}: PurchaseConfirmationEmailProps) =>
  `Your ${pass.product === "entry-pack" ? "Entry pack" : "Unlimited pass"} is paid · ${formatCzk(pass.paid)}`;

export function PurchaseConfirmationEmail(props: PurchaseConfirmationEmailProps) {
  const { accountUrl, locale, pass, refundTermsUrl } = props;
  const buyer = pass.buyer ?? pass.holder;
  const tier = tierByKey(pass.tier).label;
  const isPack = pass.product === "entry-pack";
  const forSomeoneElse = pass.holder.id !== buyer.id;
  const product = isPack
    ? `Entry pack, ${pass.size} entries`
    : "Unlimited, 30 days";
  const listPrice =
    pass.product === "entry-pack"
      ? ENTRY_PACK_PRICES[pass.tier][pass.size]
      : UNLIMITED_PRICES[pass.tier];

  return (
    <WorkspaceEmailLayout
      locale={locale}
      preview={purchaseConfirmationSubject(props)}
    >
      <WorkspaceEmailHeading>
        {`Thanks, ${firstName(buyer.name)}. Your ${isPack ? "Entry pack" : "Unlimited pass"} is paid.`}
      </WorkspaceEmailHeading>
      <WorkspaceEmailBody>
        {forSomeoneElse
          ? `We’ve emailed ${pass.holder.name} an invitation. Once they sign in with ${pass.holder.email}, the pass is theirs to use.`
          : isPack
            ? "Your entries are in your account. Book a day whenever you like; each booking uses one entry."
            : "Your 30 days are reserved. Each morning your account shows that day’s door code."}
      </WorkspaceEmailBody>

      <PassEmailAction
        button={forSomeoneElse ? "See the pass in your account" : "Open your pass"}
        url={accountUrl}
      >
        <PassEmailHero
          headline={isPack ? `${pass.size} entries` : "30 days"}
          label={isPack ? `Entry pack · ${tier}` : `Unlimited · ${tier}`}
          line={
            pass.product === "entry-pack"
              ? `Valid ${formatPeriod(pass.validFrom, pass.validUntil)}`
              : `${formatPeriod(pass.startDate, pass.endDate)}${pass.deskLabel ? ` · ${pass.deskLabel}` : ""}`
          }
        />
      </PassEmailAction>

      <PassEmailPriceTable
        lines={[
          { label: `${product} · ${tier}`, amount: formatCzk(listPrice) },
          ...(pass.discountLabel
            ? [
                {
                  label: pass.discountLabel,
                  amount: `−${formatCzk(listPrice - pass.paid + (pass.coffee ? UNLIMITED_COFFEE_PRICE : 0))}`,
                  muted: true,
                },
              ]
            : []),
          ...(pass.coffee
            ? [{ label: "Coffee for all 30 days", amount: formatCzk(UNLIMITED_COFFEE_PRICE) }]
            : []),
        ]}
        total={{ label: "Paid by card", amount: formatCzk(pass.paid) }}
      />

      <PassEmailDetails
        details={[
          { label: "Order", value: pass.id.replace("pass_", "#") },
          { label: "Pass", value: product },
          { label: "Space", value: tier },
          pass.product === "entry-pack"
            ? {
                label: "Valid",
                value: `${formatPrototypeDate(pass.validFrom)} – ${formatPrototypeDate(pass.validUntil)}`,
              }
            : {
                label: "Dates",
                value: `${formatPeriod(pass.startDate, pass.endDate)}${pass.deskLabel ? `, ${pass.deskLabel}` : ""}`,
              },
          { label: "Holder", value: forSomeoneElse ? pass.holder.name : "You" },
          ...(forSomeoneElse ? [{ label: "Their email", value: pass.holder.email }] : []),
          { label: "Paid", value: `${formatCzk(pass.paid)} on ${formatDateTime(pass.purchasedAt)}` },
        ]}
      />

      <PassEmailCallout label="Early start requested">
        {`On ${formatDateTime(pass.purchasedAt)} you asked for the pass to start right away, within the 14-day withdrawal period. You can still withdraw, and we refund the unused part: ${
          isPack
            ? `the price × unused entries ÷ ${pass.size}`
            : "the price × days not yet started ÷ 30 (today counts as used)"
        }, rounded down to whole CZK. `}
        <Link className="text-navy underline" href={refundTermsUrl} style={{ color: "#00024f" }}>
          Refund terms
        </Link>
      </PassEmailCallout>

      <WorkspaceEmailNote>
        Your invoice comes in a separate email.
      </WorkspaceEmailNote>
    </WorkspaceEmailLayout>
  );
}
