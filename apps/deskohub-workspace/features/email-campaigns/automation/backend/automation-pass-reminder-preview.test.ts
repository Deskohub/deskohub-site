import { expect, test } from "bun:test";
import { campaignLocales } from "../../recipient-locale";
import {
  nextPassReminderPreviewOccurrence,
  passReminderSampleContent,
} from "./automation-pass-reminder-preview";

test.each([
  ["2026-10-24T07:59:59Z", "2026-10-24T08:00:00Z"],
  ["2026-10-24T08:00:00Z", "2026-10-25T09:00:00Z"],
  ["2027-03-27T09:00:01Z", "2027-03-28T08:00:00Z"],
])("chooses the next 10:00 Prague occurrence from %s", (now, expected) => {
  expect(
    nextPassReminderPreviewOccurrence(
      { _tag: "EntryPackExpiring" },
      Temporal.Instant.from(now)
    ).fireAt.toString()
  ).toBe(expected);
});

test("anchors the sample expiry and renewal to the previewed occurrence", () => {
  const occurrence = Temporal.Instant.from("2026-11-27T09:00:00Z");
  const trigger = { _tag: "UnlimitedEnding" as const };
  const sample = passReminderSampleContent(trigger, occurrence)["en-US"];
  expect(sample?.subject).toContain("Wed 2 Dec");
  expect(JSON.stringify(sample?.body)).toContain("Thu 3 Dec");
  expect(
    passReminderSampleContent(trigger, occurrence.add({ hours: 24 }))["en-US"]
      ?.subject
  ).toContain("Thu 3 Dec");
});

test("provides deterministic sample copy for all locales using the approved examples", () => {
  const pack = passReminderSampleContent({ _tag: "EntryPackExpiring" });
  const unlimited = passReminderSampleContent({ _tag: "UnlimitedEnding" });
  expect(Object.keys(pack).toSorted()).toEqual(campaignLocales.toSorted());
  expect(Object.keys(unlimited).toSorted()).toEqual(campaignLocales.toSorted());
  expect(JSON.stringify(pack["en-US"]?.body)).toContain("Thu 14 Jan");
  expect(unlimited["en-US"]?.subject).toContain("Wed 2 Dec");
});
