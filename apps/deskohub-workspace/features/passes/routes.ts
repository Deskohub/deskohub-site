import type { Locale } from "@/features/i18n";
import type { OrderId } from "@/features/order";
import { reservationAccessPath } from "@/features/reservation/routes";

export const entryPackCheckoutPath = "/passes/entry-pack";

export const getUnlimitedAccessPath = (locale: Locale, orderId: OrderId) =>
  `/${locale}${reservationAccessPath}/${encodeURIComponent(orderId)}`;
