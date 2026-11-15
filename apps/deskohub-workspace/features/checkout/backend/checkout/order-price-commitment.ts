import type { WorkspaceReservation } from "@/features/reservation/backend/workspace-reservation.repository";

/**
 * Whether a payment holds the order's price: one is under way (its active
 * attempt is still created or pending, so admission marked the order
 * pending) or already paid it (a paid order stays held until fulfillment
 * confirms it). A code or referral must not replace that price. An attempt
 * that failed, was cancelled or expired stays the order's active one but
 * holds no price.
 */
export const isOrderPriceCommitted = (
  order: Pick<WorkspaceReservation, "paymentState">
) => order.paymentState === "pending" || order.paymentState === "paid";
