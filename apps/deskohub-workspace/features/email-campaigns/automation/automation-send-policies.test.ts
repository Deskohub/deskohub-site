import { describe, expect, test } from "bun:test";
import { Option } from "effect";
import { oneOffCampaignGapHold } from "./automation-send-policies";

const instant = Temporal.Instant.from;
const gap = { days: 14 };
/** Tuesday 20 October 2026, 10:00 in Prague (summer time). */
const at = instant("2026-10-20T08:00:00Z");
const inFlightRecheckAt = instant("2026-10-20T08:15:00Z");

const hold = (emails: {
  readonly latestReceivedAt: Temporal.Instant | null;
  readonly inFlight: boolean;
}) =>
  Option.map(
    oneOffCampaignGapHold({ emails, gap, at, inFlightRecheckAt }),
    String
  );

describe("oneOffCampaignGapHold", () => {
  test("holds a send until 14 Prague calendar days after the latest one-off email, across a clock change", () => {
    // 15 October, 10:00 CEST plus 14 days is 29 October, 10:00 CET.
    expect(
      hold({
        latestReceivedAt: instant("2026-10-15T08:00:00Z"),
        inFlight: false,
      })
    ).toEqual(Option.some("2026-10-29T09:00:00Z"));
  });

  test("lets the send go once the gap ends at or before the send instant", () => {
    expect(
      hold({
        latestReceivedAt: instant("2026-10-06T08:00:00Z"),
        inFlight: false,
      })
    ).toEqual(Option.none());
    expect(
      hold({
        latestReceivedAt: instant("2026-10-06T07:59:59Z"),
        inFlight: false,
      })
    ).toEqual(Option.none());
    expect(
      hold({
        latestReceivedAt: instant("2026-10-06T08:00:01Z"),
        inFlight: false,
      })
    ).toEqual(Option.some("2026-10-20T08:00:01Z"));
  });

  test("rechecks soon while a one-off email is in flight, unless a received one holds the send longer", () => {
    expect(hold({ latestReceivedAt: null, inFlight: true })).toEqual(
      Option.some("2026-10-20T08:15:00Z")
    );
    expect(
      hold({
        latestReceivedAt: instant("2026-10-01T08:00:00Z"),
        inFlight: true,
      })
    ).toEqual(Option.some("2026-10-20T08:15:00Z"));
    expect(
      hold({
        latestReceivedAt: instant("2026-10-15T08:00:00Z"),
        inFlight: true,
      })
    ).toEqual(Option.some("2026-10-29T09:00:00Z"));
  });

  test("doesn't hold a customer without one-off emails", () => {
    expect(
      oneOffCampaignGapHold({ emails: undefined, gap, at, inFlightRecheckAt })
    ).toEqual(Option.none());
  });
});
