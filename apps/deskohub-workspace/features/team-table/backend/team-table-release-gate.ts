import { ReleaseGate } from "@/features/feature-flags/backend/release-gate";

/** `team_table_page`: the Team Table page and reservations. */
export class TeamTableReleaseGate extends ReleaseGate<TeamTableReleaseGate>()(
  "@deskohub-workspace/team-table/TeamTableReleaseGate",
  "team_table_page"
) {}
