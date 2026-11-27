import type {
  CustomerReservationOrderId,
  CustomerTeamTableStatus,
} from "@deskohub/workspace-customer-api";
import { Effect, Option } from "effect";
import { Atom } from "effect/reactivity";
import { CustomerApi } from "../../customer-api/customer-api.service";
import { customerDataRuntime } from "../../customer-api/customer-data-runtime";
import { customerWrite } from "../../customer-api/customer-request";
import type { AppLocale } from "../../i18n/app-locale";
import type { ReservationListRow } from "./reservation-list-model";

/** A fresh history row identifies the booker. The server verifies the write. */
export const teamTableInviteeAdditionEndsAt = (
  order: CustomerTeamTableStatus,
  freshRow: Option.Option<ReservationListRow>
): number | undefined => {
  const booker = Option.exists(
    freshRow,
    ({ party }) => party === undefined || party.kind === "booked-for"
  );
  const { people, product, endsAt } = order;
  if (
    !booker ||
    order.paymentStatus !== "paid" ||
    order.reservationCancelled === true ||
    order.withdrawal !== undefined ||
    order.reviewSandbox === true ||
    // Resendable requires the live Dotypos record to be confirmed.
    people?.resendable !== true ||
    product === undefined ||
    Number(people.contactAttends) + people.invitees.length >= product.seats ||
    endsAt === undefined
  )
    return undefined;
  const end = Date.parse(endsAt);
  return Number.isFinite(end) ? end : undefined;
};

export const addTeamTableInvitee = (
  orderId: CustomerReservationOrderId,
  locale: AppLocale,
  email: string
) =>
  Effect.service(CustomerApi).pipe(
    Effect.flatMap((api) =>
      api.teamTable
        .addInvitees({
          params: { orderId },
          payload: { locale, emails: [email] },
        })
        .pipe(customerWrite)
    ),
    Effect.as("added" as const),
    Effect.catchTags({
      CustomerTeamTableInvitationRejected: ({ reason }) =>
        Effect.succeed(reason),
      CustomerReservationNotFound: () =>
        Effect.succeed("not-confirmed" as const),
    })
  );

export const addTeamTableInviteeAtom = Atom.family(
  (orderId: CustomerReservationOrderId) =>
    customerDataRuntime.fn(
      ({
        locale,
        email,
      }: {
        readonly locale: AppLocale;
        readonly email: string;
      }) => addTeamTableInvitee(orderId, locale, email)
    )
);
