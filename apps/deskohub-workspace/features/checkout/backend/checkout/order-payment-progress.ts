import type { WorkspaceReservation } from "@/features/reservation/backend/workspace-reservation.repository";

/**
 * Whether a payment of the order is under way: its active attempt is still
 * created or pending (admission marks the order pending, and every settling
 * or ending transition moves it on). An attempt that failed, was cancelled or
 * expired stays the order's active one but no longer blocks a new price.
 */
export const isOrderPaymentInProgress = (
  order: Pick<WorkspaceReservation, "paymentState">
) => order.paymentState === "pending";
