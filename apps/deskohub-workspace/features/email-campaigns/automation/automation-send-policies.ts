import type { AutomationOneOffCampaignGapType as AutomationOneOffCampaignGap } from "@deskohub/workspace-admin-api";
import { workspaceSiteConstants } from "@/shared/utils";
import { addCalendarDuration } from "@/shared/utils/temporal";

/**
 * When a Send's one-off campaign gap after the customer's latest one-off
 * marketing email ends: that many Prague calendar days later. The send may
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
