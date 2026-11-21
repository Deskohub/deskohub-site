import "server-only";

import { ReleaseGate } from "@/features/feature-flags/backend/release-gate";
import { releaseGateForRequest } from "@/features/feature-flags/backend/release-gate.server";
import { releaseGateForRun } from "@/features/feature-flags/backend/release-gate-run";

export class CoworkPassesReleaseGate extends ReleaseGate<CoworkPassesReleaseGate>()(
  "@deskohub-workspace/passes/CoworkPassesReleaseGate",
  "cowork_passes"
) {}

const coworkPassesRequest = releaseGateForRequest(CoworkPassesReleaseGate, {
  operation: "passes.cowork-passes-page-enabled",
  whenRunFails: "close",
  failureCode: "passes.cowork-passes-release-gate",
});

export const isCoworkPassesPageOpenAfterConnection = coworkPassesRequest.isOpen;

export const CoworkPassesReleaseGateForRun = releaseGateForRun(
  CoworkPassesReleaseGate,
  {
    whenRunFails: "close",
    failureCode: "passes.cowork-passes-release-gate",
  }
);
