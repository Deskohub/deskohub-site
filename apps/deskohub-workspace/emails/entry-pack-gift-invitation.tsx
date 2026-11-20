import { type Locale, m } from "@/features/i18n";
import {
  type EntryPackSize,
  getEntryPackLastUsableDate,
  type PassTier,
} from "@/features/passes/pass-offer";
import { getPassTierName } from "@/features/passes/pass-offer.i18n";
import { formatPlainDate } from "@/shared/utils/date-time-format";
import type { PlainDate } from "@/shared/utils/temporal";
import { EntryPackEmailCard } from "./_components/entry-pack-email-card";
import {
  WorkspaceEmailBody,
  WorkspaceEmailHeading,
  WorkspaceEmailNote,
} from "./_components/workspace-email-content";
import { WorkspaceEmailDetails } from "./_components/workspace-email-details";
import { WorkspaceEmailLayout } from "./_components/workspace-email-layout";

export type EntryPackGiftInvitationEmailProps = {
  readonly buyerName: string | null;
  readonly claimUrl: string;
  readonly holderEmail: string;
  readonly entryCount: EntryPackSize;
  readonly locale: Locale;
  readonly tier: PassTier;
  readonly validUntil: PlainDate;
};

export const entryPackGiftInvitationSubject = ({
  buyerName,
  locale,
}: Pick<EntryPackGiftInvitationEmailProps, "buyerName" | "locale">) =>
  buyerName
    ? m.passGiftMailSubject({ buyer: buyerName }, { locale })
    : m.passGiftMailSubjectUnnamed({}, { locale });

export function EntryPackGiftInvitationEmail({
  buyerName,
  claimUrl,
  holderEmail,
  entryCount,
  locale,
  tier,
  validUntil,
}: EntryPackGiftInvitationEmailProps) {
  const options = { locale };
  const product = m.passEntryPack({}, options);
  const entries = m.passEntryCount({ count: entryCount }, options);
  const space = getPassTierName(tier, locale);
  const lastDay = formatPlainDate({
    date: getEntryPackLastUsableDate(validUntil),
    locale,
  });

  return (
    <WorkspaceEmailLayout
      locale={locale}
      preview={entryPackGiftInvitationSubject({ buyerName, locale })}
    >
      <WorkspaceEmailHeading>
        {buyerName
          ? m.passGiftMailTitle({ buyer: buyerName }, options)
          : m.passGiftMailTitleUnnamed({}, options)}
      </WorkspaceEmailHeading>
      <WorkspaceEmailBody>
        {m.passGiftMailBody({ entries, space }, options)}
      </WorkspaceEmailBody>
      <EntryPackEmailCard
        action={{ label: m.passGiftMailClaim({}, options), url: claimUrl }}
        dates={m.passGiftMailUseBy({ date: lastDay }, options)}
        entryCount={entryCount}
        locale={locale}
        tier={tier}
      />
      <WorkspaceEmailDetails
        details={[
          ...(buyerName
            ? [{ label: m.passGiftMailFrom({}, options), value: buyerName }]
            : []),
          {
            label: m.passGiftMailPass({}, options),
            value: `${product}, ${entries}`,
          },
          { label: m.passGiftMailSpace({}, options), value: space },
          { label: m.entryPackCheckoutValidUntil({}, options), value: lastDay },
          { label: m.passGiftMailYourEmail({}, options), value: holderEmail },
        ]}
      />
      <WorkspaceEmailNote>
        {m.passGiftMailBooking({}, options)}
        {tier === "open-space" && ` ${m.passGiftMailCoffee({}, options)}`}
      </WorkspaceEmailNote>
      <WorkspaceEmailNote>
        {m.passGiftMailIgnore({ email: holderEmail }, options)}
      </WorkspaceEmailNote>
    </WorkspaceEmailLayout>
  );
}
