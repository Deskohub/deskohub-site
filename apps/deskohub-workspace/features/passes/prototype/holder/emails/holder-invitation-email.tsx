// PROTOTYPE ONLY (#1361): the email a pass holder gets when someone else
// bought them an Entry pack or Unlimited. Not wired to any sender.
import {
  WorkspaceEmailBody,
  WorkspaceEmailHeading,
  WorkspaceEmailNote,
} from "@/emails/_components/workspace-email-content";

import { WorkspaceEmailLayout } from "@/emails/_components/workspace-email-layout";
import type { Locale } from "@/features/i18n";
import {
  formatPrototypeDate,
  type PrototypePass,
  tierByKey,
} from "@/features/passes/prototype/mock-passes";
import { formatPeriod } from "../holder-mock";
import { PassEmailAction, PassEmailDetails, PassEmailHero } from "./pass-email-parts";

export type HolderInvitationEmailProps = {
  readonly locale: Locale;
  readonly pass: PrototypePass;
  readonly signInUrl: string;
};

const firstName = (name: string) => name.split(" ")[0] ?? name;

export const holderInvitationSubject = ({ pass }: HolderInvitationEmailProps) =>
  `${pass.buyer?.name ?? "Deskohub"} gave you ${
    pass.product === "entry-pack" ? "an Entry pack" : "30 days of Unlimited"
  } at Deskohub Workspace`;

export function HolderInvitationEmail(props: HolderInvitationEmailProps) {
  const { locale, pass, signInUrl } = props;
  const buyer = pass.buyer?.name ?? "Deskohub";
  const tier = tierByKey(pass.tier).label;
  const isPack = pass.product === "entry-pack";

  return (
    <WorkspaceEmailLayout locale={locale} preview={holderInvitationSubject(props)}>
      <WorkspaceEmailHeading>
        {isPack
          ? `${buyer} gave you an Entry pack`
          : `${buyer} gave you 30 days of Unlimited`}
      </WorkspaceEmailHeading>
      <WorkspaceEmailBody>
        {`Hi ${firstName(pass.holder.name)}, ${buyer} bought you ${
          isPack
            ? `${pass.size} days of coworking in our ${tier}`
            : `30 days in a row of coworking in our ${tier}`
        } at Deskohub Workspace in Prague. Sign in with this email address to confirm it’s you. The pass then shows up in your account, ready to use.`}
      </WorkspaceEmailBody>

      <PassEmailAction button="Sign in and start using it" url={signInUrl}>
        <PassEmailHero
          headline={isPack ? `${pass.size} entries` : "30 days"}
          label={isPack ? `Entry pack · ${tier}` : `Unlimited · ${tier}`}
          line={
            pass.product === "entry-pack"
              ? `Use them by ${formatPrototypeDate(pass.validUntil)}, one day at a time`
              : `${formatPeriod(pass.startDate, pass.endDate)}, a new door code every day`
          }
        />
      </PassEmailAction>

      <PassEmailDetails
        details={[
          { label: "From", value: buyer },
          {
            label: "Pass",
            value: isPack
              ? `Entry pack, ${pass.size} entries`
              : "Unlimited, 30 days",
          },
          { label: "Space", value: tier },
          pass.product === "entry-pack"
            ? { label: "Valid until", value: formatPrototypeDate(pass.validUntil) }
            : { label: "Dates", value: formatPeriod(pass.startDate, pass.endDate) },
          { label: "Your email", value: pass.holder.email },
        ]}
      />

      <WorkspaceEmailNote>
        {isPack
          ? "After you sign in, book each day from your account. Each booking uses one entry; you can add coffee when you book."
          : "After you sign in, your account shows each day’s door code. There’s nothing to book."}
      </WorkspaceEmailNote>
      <WorkspaceEmailNote>
        {`Not expecting this? You can ignore this email. Only someone who signs in with ${pass.holder.email} can use the pass.`}
      </WorkspaceEmailNote>
    </WorkspaceEmailLayout>
  );
}
