import { Match, Schema } from "effect";
import {
  entryPackProductKeySchema,
  entryPackProductSchema,
  getPassProductKey,
  unlimitedPassProductKeySchema,
  unlimitedPassProductSchema,
} from "@/features/passes/pass-offer";
import {
  getWorkspaceCoworkProductKey,
  workspaceCoworkProductIdentitySchema,
  workspaceCoworkProductKeySchema,
} from "@/features/reservation/cowork-reservation-product";
import {
  getWorkspaceMeetingRoomProductKey,
  workspaceMeetingRoomProductIdentitySchema,
  workspaceMeetingRoomProductKeySchema,
} from "@/features/reservation/meeting-room-reservation";
import {
  getWorkspaceOfficeProductKey,
  workspaceOfficeProductIdentitySchema,
  workspaceOfficeProductKeySchema,
} from "@/features/reservation/office-reservation";
import {
  getWorkspaceTableProductKey,
  workspaceTableProductIdentitySchema,
  workspaceTableProductKeySchema,
} from "@/features/reservation/table-reservation";

export const workspaceProductIdentitySchema = Schema.Union([
  workspaceCoworkProductIdentitySchema,
  workspaceMeetingRoomProductIdentitySchema,
  workspaceOfficeProductIdentitySchema,
  workspaceTableProductIdentitySchema,
  entryPackProductSchema,
  unlimitedPassProductSchema,
]);

export type WorkspaceProductIdentity =
  typeof workspaceProductIdentitySchema.Type;

export const workspaceProductKeySchema = Schema.Union([
  workspaceCoworkProductKeySchema,
  workspaceMeetingRoomProductKeySchema,
  workspaceOfficeProductKeySchema,
  workspaceTableProductKeySchema,
  entryPackProductKeySchema,
  unlimitedPassProductKeySchema,
]);

export type WorkspaceProductKey = typeof workspaceProductKeySchema.Type;

export const getWorkspaceProductKey = (
  product: WorkspaceProductIdentity
): WorkspaceProductKey =>
  Match.value(product).pipe(
    Match.discriminatorsExhaustive("kind")({
      cowork: getWorkspaceCoworkProductKey,
      "meeting-room": getWorkspaceMeetingRoomProductKey,
      office: getWorkspaceOfficeProductKey,
      table: getWorkspaceTableProductKey,
      "entry-pack": getPassProductKey,
      unlimited: getPassProductKey,
    })
  );

export const getCanonicalWorkspaceProductIdentity = (
  product: WorkspaceProductIdentity
): WorkspaceProductIdentity =>
  Match.value(product).pipe(
    Match.discriminatorsExhaustive("kind")({
      cowork: ({ kind, tier }) => ({ kind, tier }),
      "meeting-room": ({ duration, kind }) => ({
        kind,
        duration,
      }),
      office: ({ dayCount, kind, seats }) => ({ kind, seats, dayCount }),
      table: ({ durationMinutes, kind, seats }) => ({
        kind,
        seats,
        durationMinutes,
      }),
      "entry-pack": ({ kind, size, tier }) => ({ kind, size, tier }),
      unlimited: ({ kind, tier }) => ({ kind, tier }),
    })
  );
