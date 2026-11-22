import type { AutomationTriggerType } from "@deskohub/workspace-admin-api";
import { Effect } from "effect";
import { isPassReminderTrigger } from "../automation-triggers";
import { AutomationFlowInvalid } from "../errors";

/** Publish the trigger readers before allowing any pass reminder records. */
export const ensurePassReminderWritesAllowed = (
  trigger: AutomationTriggerType
) =>
  isPassReminderTrigger(trigger)
    ? Effect.fail(
        new AutomationFlowInvalid({
          location: { _tag: "Trigger" },
          message: "Pass reminder triggers are not available yet.",
        })
      )
    : Effect.void;
