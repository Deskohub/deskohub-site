import {
  coworkReservationKind,
  meetingRoomReservationKind,
  officeReservationKind,
} from "@deskohub/workspace-domain/features/reservation/reservation-kind";

export {
  coworkReservationKind,
  meetingRoomReservationKind,
  officeReservationKind,
} from "@deskohub/workspace-domain/features/reservation/reservation-kind";

import { Schema } from "effect";

export const workspaceReservationKindSchema = Schema.Literals([
  coworkReservationKind,
  meetingRoomReservationKind,
  officeReservationKind,
]);

export type WorkspaceReservationKind =
  typeof workspaceReservationKindSchema.Type;
