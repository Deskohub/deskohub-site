import { type Locale, m } from "@/features/i18n";
import { type PassTier, unlimitedPassDays } from "@/features/passes/pass-offer";
import { getPassTierName } from "@/features/passes/pass-offer.i18n";
import { formatCount } from "@/shared/utils/number";
import type { PlainDate } from "@/shared/utils/temporal";
import {
  type CampaignBodyDocument,
  type CampaignBodyNode,
  campaignBodyFormatVersion,
} from "./campaign-body-document";
import type { CampaignLocaleContent } from "./campaign-content";

export type PassReminderCopyInput = {
  readonly locale: Locale;
  readonly firstName?: string | undefined;
  readonly tier: PassTier;
  readonly endsOn: PlainDate;
  /** The caller generates this absolute HTTPS link for the recipient's pass. */
  readonly actionUrl: string;
} & (
  | {
      readonly product: "entry-pack";
      readonly remainingEntries: number;
      readonly totalEntries: number;
    }
  | {
      readonly product: "unlimited";
      readonly renewalStartsOn: PlainDate;
      readonly deskLabel?: string | undefined;
    }
);

const formatReminderDate = (date: PlainDate, locale: Locale) => {
  const english = locale === "en-US";
  // The approved English copy uses day before month and no comma.
  const formatted = Temporal.PlainDate.from(date).toLocaleString(
    english ? "en-GB" : locale,
    { weekday: "short", day: "numeric", month: english ? "short" : "long" }
  );
  return english ? formatted.replace(",", "") : formatted;
};

const paragraph = (text: string): CampaignBodyNode => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

const emphasizedParagraph = (
  copy: string,
  deskLabel?: string
): CampaignBodyNode => ({
  type: "paragraph",
  // Interpret catalog emphasis before inserting the literal desk label.
  content: copy.split(/<strong>(.*?)<\/strong>/s).flatMap((text, index) => {
    if (text === "") return [];
    if (index % 2 === 0) return [{ type: "text", text }];
    return [
      {
        type: "text",
        text: text === "{deskLabel}" ? (deskLabel ?? text) : text,
        marks: [{ type: "bold" }],
      },
    ];
  }),
});

const actionButton = (label: string, href: string): CampaignBodyNode => ({
  type: "ctaButton",
  attrs: { label, href },
});

const body = (
  ...content: readonly CampaignBodyNode[]
): CampaignBodyDocument => ({
  formatVersion: campaignBodyFormatVersion,
  doc: { type: "doc", content },
});

/** Customer copy used by the first version of the pass reminder campaigns. */
export const renderPassReminderCopyV1 = (
  input: PassReminderCopyInput
): CampaignLocaleContent => {
  const { locale, actionUrl } = input;
  const options = { locale };
  const tier = getPassTierName(input.tier, locale);
  const endsOn = formatReminderDate(input.endsOn, locale);
  const firstName = input.firstName?.trim();
  const greeting = paragraph(
    firstName
      ? m.passReminderGreeting({ firstName }, options)
      : m.passReminderGreetingUnnamed({}, options)
  );

  if (input.product === "entry-pack") {
    const counts = {
      remaining: input.remainingEntries,
      total: input.totalEntries,
    };
    return {
      subject: m.passReminderEntryPackSubject(counts, options),
      preheader: m.passReminderEntryPackPreheader({ tier, endsOn }, options),
      body: body(
        greeting,
        emphasizedParagraph(
          m.passReminderEntryPackBody({ tier, endsOn, ...counts }, options)
        ),
        actionButton(m.passReminderEntryPackBook({}, options), actionUrl),
        paragraph(m.passReminderEntryPackExpiry({}, options))
      ),
    };
  }

  const deskLabel =
    input.tier === "open-space" ? undefined : input.deskLabel?.trim();
  const days = formatCount(unlimitedPassDays, locale);
  const renewal = {
    tier,
    endsOn,
    days,
    renewalStartsOn: formatReminderDate(input.renewalStartsOn, locale),
  };
  const details = deskLabel
    ? m.passReminderUnlimitedBodyWithDesk(
        { ...renewal, deskLabel: "{deskLabel}" },
        options
      )
    : m.passReminderUnlimitedBody(renewal, options);

  return {
    subject: m.passReminderUnlimitedSubject({ endsOn }, options),
    preheader: deskLabel
      ? m.passReminderUnlimitedPreheaderWithDesk({ days, deskLabel }, options)
      : m.passReminderUnlimitedPreheader({ days }, options),
    body: body(
      greeting,
      emphasizedParagraph(details, deskLabel),
      actionButton(m.passReminderUnlimitedRenew({ days }, options), actionUrl),
      ...(deskLabel
        ? [
            paragraph(
              m.passReminderUnlimitedDeskFallback({ deskLabel }, options)
            ),
          ]
        : [])
    ),
  };
};
