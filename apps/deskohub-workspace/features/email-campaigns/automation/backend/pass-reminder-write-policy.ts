import type { AutomationTriggerType } from "@deskohub/workspace-admin-api";
import { Context, Effect } from "effect";
import { CoworkPassesReleaseGate } from "@/features/passes/backend/cowork-passes-release-gate";
import type { CampaignPurpose } from "../../body/campaign-content";
import { isPassReminderTrigger } from "../automation-triggers";
import { AutomationFlowInvalid } from "../errors";
import { CoworkPassesReleaseGateForReminders } from "./pass-reminder-release";

export const PassReminderWritesOpen = Context.Reference<Effect.Effect<boolean>>(
  "@deskohub-workspace/email-campaigns/PassReminderWritesOpen",
  {
    defaultValue: () =>
      CoworkPassesReleaseGate.isOpen.pipe(
        Effect.provide(CoworkPassesReleaseGateForReminders)
      ),
  }
);

export const ensurePassReminderWritesAllowed = (
  trigger: AutomationTriggerType,
  purpose: CampaignPurpose
) => {
  if (!isPassReminderTrigger(trigger)) return Effect.void;
  return Effect.flatMap(PassReminderWritesOpen, (open) => open).pipe(
    Effect.flatMap((open) => {
      if (!open)
        return Effect.fail(
          invalidTrigger("Pass reminder triggers are unavailable.")
        );
      if (purpose !== "marketing")
        return Effect.fail(
          invalidTrigger("Pass reminders require a marketing campaign.")
        );
      return Effect.void;
    })
  );
};

const invalidTrigger = (message: string) =>
  new AutomationFlowInvalid({ location: { _tag: "Trigger" }, message });
