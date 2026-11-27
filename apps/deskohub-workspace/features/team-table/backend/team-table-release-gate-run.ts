import { releaseGateForRun } from "@/features/feature-flags/backend/release-gate-run";
import { TeamTableReleaseGate } from "./team-table-release-gate";

export const TeamTableReleaseGateForRun = releaseGateForRun(
  TeamTableReleaseGate,
  {
    whenRunFails: "reject",
  }
);
