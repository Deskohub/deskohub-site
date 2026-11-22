import type { AutomationOneOffCampaignGapType as AutomationOneOffCampaignGap } from "@deskohub/workspace-admin-api";
import { Option } from "effect";
import { workspaceSiteConstants } from "@/shared/utils";
import { addCalendarDuration } from "@/shared/utils/temporal";
import type { OneOffCampaignEmails } from "../backend/campaign-candidate.repository";

/**
 * When a Send's one-off campaign gap after the customer's latest one-off
 * campaign email ends: that many Prague calendar days later. The send may
 * go out at this instant.
 */
export const oneOffCampaignGapEndsAt = (
  latestOneOffEmailAt: Temporal.Instant,
  gap: AutomationOneOffCampaignGap
) =>
  addCalendarDuration({
    instant: latestOneOffEmailAt,
    duration: { days: gap.days },
    timeZone: workspaceSiteConstants.location.timeZone,
  });

/**
 * When a send the one-off campaign gap holds at `at` is checked again: the
 * gap's end after the latest one-off email the customer received, while
 * it's still ahead, or `inFlightRecheckAt` while a one-off email is in
 * flight to them, whichever is later. None when the gap doesn't hold it;
 * a gap ending exactly at `at` has ended.
 */
export const oneOffCampaignGapHold = (input: {
  readonly emails: OneOffCampaignEmails | undefined;
  readonly gap: AutomationOneOffCampaignGap;
  readonly at: Temporal.Instant;
  readonly inFlightRecheckAt: Temporal.Instant;
}): Option.Option<Temporal.Instant> => {
  const { emails } = input;
  if (emails === undefined) return Option.none();
  const holds = [
    ...(emails.latestReceivedAt === null
      ? []
      : [oneOffCampaignGapEndsAt(emails.latestReceivedAt, input.gap)]
    ).filter((end) => Temporal.Instant.compare(end, input.at) > 0),
    ...(emails.inFlight ? [input.inFlightRecheckAt] : []),
  ];
  return holds.length === 0
    ? Option.none()
    : Option.some(holds.reduce(laterInstant));
};

const laterInstant = (a: Temporal.Instant, b: Temporal.Instant) =>
  Temporal.Instant.compare(a, b) >= 0 ? a : b;
