import { describe, expect, test } from "bun:test";
import {
  getTableBookingSelection,
  getTableBookingTimes,
} from "./table-booking-selection";

describe("Team Table booking selection", () => {
  test("opens a size from live inventory and keeps a valid linked date and slot", () => {
    expect(
      getTableBookingSelection(
        { seats: 6, date: "2026-12-01", startTime: "09:15", endTime: "10:00" },
        { today: "2026-11-27", capacities: [4, 6] }
      )
    ).toEqual({
      seats: 6,
      date: "2026-12-01",
      startTime: "09:15",
      endTime: "10:00",
    });
  });

  test("does not take a time from an unsupported size or out-of-range date", () => {
    expect(
      getTableBookingSelection(
        { seats: 3, date: "2027-05-28", startTime: "09:15", endTime: "10:00" },
        { today: "2026-11-27", capacities: [4, 6] }
      )
    ).toEqual({ seats: 4, date: "2026-11-27", startTime: "", endTime: "" });
  });

  test("uses only the selected start's ends for the current size and date", () => {
    const available = {
      date: "2026-12-01",
      seats: 4,
      availableStarts: ["09:00", "09:15"],
      availableEndsByStart: [
        { startTime: "09:00", endTimes: ["09:15", "09:30"] },
        { startTime: "09:15", endTimes: ["09:30"] },
      ],
    };
    const selection = {
      date: "2026-12-01",
      seats: 4,
      startTime: "09:15",
      endTime: "09:30",
    };

    expect(getTableBookingTimes(available, selection)).toEqual({
      startTimes: ["09:00", "09:15"],
      endTimes: ["09:30"],
    });
    expect(getTableBookingTimes(available, { ...selection, seats: 6 })).toEqual(
      {
        startTimes: [],
        endTimes: [],
      }
    );
    expect(
      getTableBookingTimes(available, { ...selection, date: "2026-12-02" })
    ).toEqual({ startTimes: [], endTimes: [] });
  });
});
