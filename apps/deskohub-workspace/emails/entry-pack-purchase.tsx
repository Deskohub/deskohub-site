import { Link, Section, Text } from "react-email";
import type { DiscountQuote } from "@/features/discounts/contracts";
import { type Locale, m } from "@/features/i18n";
import type { OrderId } from "@/features/order";
import type { EntryPackSize, PassTier } from "@/features/passes/pass-offer";
import { getPassTierName } from "@/features/passes/pass-offer.i18n";
import { formatMoney } from "@/shared/money/money";
import { workspaceSiteConstants } from "@/shared/utils";
import {
  formatInstantDateTime,
  formatPlainDateRange,
} from "@/shared/utils/date-time-format";
import type { PlainDate } from "@/shared/utils/temporal";
import { EntryPackEmailCard } from "./_components/entry-pack-email-card";
import {
  WorkspaceEmailBody,
  WorkspaceEmailHeading,
  WorkspaceEmailLabel,
  WorkspaceEmailNote,
} from "./_components/workspace-email-content";
import { WorkspaceEmailDetails } from "./_components/workspace-email-details";
import { WorkspaceEmailLayout } from "./_components/workspace-email-layout";

export type EntryPackPurchaseEmailProps = {
  readonly orderId: OrderId;
  readonly tier: PassTier;
  readonly entryCount: EntryPackSize;
  readonly validFrom: PlainDate;
  readonly validUntil: PlainDate;
  readonly paidAt: Temporal.Instant;
  readonly quote: DiscountQuote;
  readonly holderEmail: string | null;
  readonly gift?: boolean;
  readonly invitationSent?: boolean;
  readonly invoiceRequested: boolean;
  readonly locale: Locale;
  readonly statusUrl: string;
  readonly termsUrl: string;
};

export const entryPackPurchaseEmailSubject = ({
  locale,
}: Pick<EntryPackPurchaseEmailProps, "locale">) =>
  m.passEmailSubject({}, { locale });

export function EntryPackPurchaseEmail(props: EntryPackPurchaseEmailProps) {
  const { locale, orderId, paidAt, quote, holderEmail } = props;
  const options = { locale };
  const title = entryPackPurchaseEmailSubject(props);
  const product = m.passEntryPack({}, options);
  const count = m.passEntryCount({ count: props.entryCount }, options);
  const invited = props.invitationSent && holderEmail;
  const paidBody =
    props.gift || holderEmail
      ? m.passEmailGiftBody({}, options)
      : m.passEmailSelfBody({}, options);
  const dates = formatPlainDateRange({
    start: Temporal.PlainDate.from(props.validFrom),
    end: Temporal.PlainDate.from(props.validUntil).subtract({ days: 1 }),
    locale,
  });
  const money = (amount: DiscountQuote["discountedSubtotal"]) =>
    formatMoney(amount, locale);

  return (
    <WorkspaceEmailLayout locale={locale} preview={title}>
      <WorkspaceEmailHeading>{title}</WorkspaceEmailHeading>
      <WorkspaceEmailBody>
        {invited
          ? m.passGiftMailBuyerInvited({ email: invited }, options)
          : paidBody}
      </WorkspaceEmailBody>

      {invited ? (
        <EntryPackEmailCard
          action={{
            label: m.passGiftMailBuyerOpen({}, options),
            url: props.statusUrl,
          }}
          dates={m.passEmailValid({ dates }, options)}
          entryCount={props.entryCount}
          locale={locale}
          tier={props.tier}
        />
      ) : (
        <Section className="mt-6 overflow-hidden rounded-[22px] border border-[#d8d9e4]">
          <Section bgcolor="#00024f" className="bg-navy px-4 py-6 text-center">
            <Link
              className="inline-block rounded-full px-7 py-3 text-[14px] font-bold text-navy no-underline"
              href={props.statusUrl}
              style={{ backgroundColor: "#00df99", color: "#00024f" }}
            >
              {m.passEmailOpen({}, options)}
            </Link>
          </Section>
          <Section className="border-t-4 border-aquamarine bg-[#e9fff6] px-5 py-5 text-center">
            <WorkspaceEmailLabel>
              {product} · {getPassTierName(props.tier, locale)}
            </WorkspaceEmailLabel>
            <Text className="m-0 mt-1 text-[38px] font-bold leading-[46px] text-navy">
              {count}
            </Text>
            <Text className="m-0 mt-1 text-[14px] text-navy">
              {m.passEmailValid({ dates }, options)}
            </Text>
          </Section>
        </Section>
      )}

      <WorkspaceEmailDetails
        details={[
          { label: product, value: money(quote.discountableSubtotal) },
          ...quote.discounts.map(({ discount, amount }) => ({
            label: discount.label,
            value: `−${money(amount)}`,
          })),
          {
            label:
              quote.discountedSubtotal.value === 0
                ? m.checkoutSummarySectionTotal({}, options)
                : m.passEmailPaidByCard({}, options),
            value: money(quote.discountedSubtotal),
          },
        ]}
      />

      <WorkspaceEmailDetails
        details={[
          { label: m.checkoutSummarySectionOrder({}, options), value: orderId },
          ...(holderEmail
            ? [{ label: m.passEmailFor({}, options), value: holderEmail }]
            : []),
          {
            label: m.passEmailPaidOn({}, options),
            value: formatInstantDateTime({
              instant: paidAt,
              locale,
              timeZone: workspaceSiteConstants.location.timeZone,
            }),
          },
        ]}
      />

      <Section className="mt-6 rounded-2xl bg-cream px-5 py-4">
        <Text className="m-0 text-[14px] leading-[23px] text-navy">
          {m.passEmailEarlyStart({}, options)}{" "}
          <Link href={props.termsUrl} style={{ color: "#00024f" }}>
            {m.passEmailRefundTerms({}, options)}
          </Link>
        </Text>
      </Section>

      {props.invoiceRequested && (
        <WorkspaceEmailNote>
          {m.passEmailInvoice({}, options)}
        </WorkspaceEmailNote>
      )}
    </WorkspaceEmailLayout>
  );
}
