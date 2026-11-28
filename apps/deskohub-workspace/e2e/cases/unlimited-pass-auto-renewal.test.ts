import { expect, test } from "bun:test";
import { unlimitedPassDays } from "@/features/passes/pass-offer";
import { getWorkspaceAvailabilityRange } from "@/features/reservation/workspace-availability";
import {
  workspaceE2EConcurrentRunTarget,
  workspaceE2EFullDateAllocation,
} from "../allocation";
import { getUnlimitedPassE2EStart } from "./unlimited-pass-auto-renewal";

test("gives leased passes disjoint dates beyond ordinary checkout, even across midnight", () => {
  const today = Temporal.PlainDate.from("2027-02-28");
  const latestStart = getWorkspaceAvailabilityRange(today.toString()).to;
  let previousEnd = today.add({
    days: workspaceE2EFullDateAllocation.toOffsetDays,
  });

  for (
    let shardIndex = 0;
    shardIndex < workspaceE2EConcurrentRunTarget;
    shardIndex++
  ) {
    const allocation = {
      ...workspaceE2EFullDateAllocation,
      shardCount: workspaceE2EConcurrentRunTarget,
      shardIndex,
    };
    const start = getUnlimitedPassE2EStart(allocation, today);
    expect(Temporal.PlainDate.compare(start, previousEnd)).toBeGreaterThan(0);
    expect(start.toString() <= latestStart).toBe(true);
    previousEnd = getUnlimitedPassE2EStart(
      allocation,
      today.add({ days: 1 })
    ).add({ days: unlimitedPassDays - 1 });
  }
});
