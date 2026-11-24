import { Match, type Option, Schema } from "effect";
import { type OrderId, orderIdSchema } from "@/features/order";
import type { NormalizedCoworkReservationOrder } from "@/features/reservation/cowork-reservation";
import {
  getStoredCoworkReservationDetails,
  storedCoworkReservationDetailsSchema,
} from "@/features/reservation/cowork-reservation-product";
import {
  getStoredMeetingRoomReservationDetails,
  storedMeetingRoomReservationDetailsSchema,
} from "@/features/reservation/meeting-room-reservation";
import {
  getStoredOfficeReservationDetails,
  storedOfficeReservationDetailsSchema,
} from "@/features/reservation/office-reservation";
import type { ReservationOrderData } from "@/features/reservation/reservation-order";

export const storedWorkspaceReservationDetailsSchema = Schema.Union([
  storedCoworkReservationDetailsSchema,
  storedMeetingRoomReservationDetailsSchema,
  storedOfficeReservationDetailsSchema,
]).annotate({
  identifier: "StoredWorkspaceReservationDetails",
  description:
    "App-owned reservation-family details persisted without provider-owned facts.",
});

export type StoredWorkspaceReservationDetails =
  typeof storedWorkspaceReservationDetailsSchema.Type;

export const getStoredWorkspaceReservationDetails = (
  // Historical recovery paths pass full normalized orders, so every stored
  // cowork tier stays decodable here even though public order issuance only
  // produces the saleable offers.
  reservation:
    | NormalizedCoworkReservationOrder
    | Exclude<ReservationOrderData, { readonly kind: "cowork" }>
): StoredWorkspaceReservationDetails =>
  Match.value(reservation).pipe(
    Match.discriminatorsExhaustive("kind")({
      cowork: getStoredCoworkReservationDetails,
      "meeting-room": getStoredMeetingRoomReservationDetails,
      office: getStoredOfficeReservationDetails,
    })
  );

export const workspaceReservationIdSchema = Schema.NonEmptyString.pipe(
  Schema.brand("WorkspaceReservationId")
).annotate({
  identifier: "WorkspaceReservationId",
  description: "Opaque identifier for a persisted workspace reservation.",
});

export type WorkspaceReservationId = Schema.Schema.Type<
  typeof workspaceReservationIdSchema
>;

/**
 * The order a standalone reservation is mirrored into. The database mirrors
 * each standalone reservation into a `reservation` order with the same UUID.
 * Unlimited-pass days belong to their pass purchase order and review-sandbox
 * samples have no order, so their IDs find none.
 */
export const findReservationOrderId: (
  reservationId: WorkspaceReservationId
) => Option.Option<OrderId> = Schema.decodeOption(orderIdSchema);

/** The reservation ID carried by an order already known to be a reservation. */
export const reservationIdForOrder = (
  orderId: OrderId
): WorkspaceReservationId => workspaceReservationIdSchema.make(orderId);
