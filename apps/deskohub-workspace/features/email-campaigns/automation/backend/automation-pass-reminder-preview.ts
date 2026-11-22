import { mapSupportedLocales } from "@deskohub/i18n/locale-registry";
import type { AutomationTriggerType } from "@deskohub/workspace-admin-api";
import {
  getPassReminderDueAt,
  getPassReminderEndDates,
  type PassReminderKind,
} from "@/features/passes/pass-reminder-schedule";
import { getWorkspaceDate } from "@/features/reservation/reservation-date";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import type { CampaignLocalizedContent } from "../../body/campaign-content";
import { renderPassReminderCopyV1 } from "../../body/pass-reminder-copy";

type PassReminderTrigger = Extract<
  AutomationTriggerType,
  { readonly _tag: "EntryPackExpiring" | "UnlimitedEnding" }
>;

const reminderKind = (trigger: PassReminderTrigger): PassReminderKind =>
  trigger._tag === "EntryPackExpiring" ? "entry-pack" : "unlimited";

export const nextPassReminderPreviewOccurrence = (
  trigger: PassReminderTrigger,
  now: Temporal.Instant
) => {
  const today = getWorkspaceDate(now);
  const todayAt = getPassReminderDueAt(
    plainDateStringSchema.make(today.toString())
  );
  const dueDate = plainDateStringSchema.make(
    (Temporal.Instant.compare(todayAt, now) > 0
      ? today
      : today.add({ days: 1 })
    ).toString()
  );
  return {
    kind: reminderKind(trigger),
    dueDate,
    fireAt: getPassReminderDueAt(dueDate),
  };
};

const sampleDueDates = {
  "entry-pack": "2027-01-07",
  unlimited: "2026-11-27",
} as const;

/** Code-owned copy with example pass details. Published samples use fixed dates. */
export const passReminderSampleContent = (
  trigger: PassReminderTrigger,
  fireAt?: Temporal.Instant
): CampaignLocalizedContent => {
  const product = reminderKind(trigger);
  const dueDate = plainDateStringSchema.make(
    fireAt === undefined
      ? sampleDueDates[product]
      : getWorkspaceDate(fireAt).toString()
  );
  const { lastUsableDate: endsOn, validUntil } = getPassReminderEndDates(
    product,
    dueDate
  );
  const common = {
    tier: "reserved-desk" as const,
    endsOn,
    actionUrl: "https://example.com/",
  };
  return mapSupportedLocales((locale) =>
    renderPassReminderCopyV1(
      product === "entry-pack"
        ? { ...common, locale, product, remainingEntries: 2, totalEntries: 5 }
        : {
            ...common,
            locale,
            product,
            renewalStartsOn: validUntil,
            deskLabel: "Desk 14",
          }
    )
  );
};
