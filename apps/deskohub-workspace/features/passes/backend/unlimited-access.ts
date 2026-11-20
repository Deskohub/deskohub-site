import { DotyposService } from "@deskohub/dotypos";
import { and, eq, isNotNull, or } from "drizzle-orm";
import { Effect, Layer, Option, Result } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { passPurchases, workspaceReservations } from "@/db/schema";
import { CurrentCustomerAccount } from "@/features/account/backend/current-customer-account";
import type { CustomerAccountId } from "@/features/account/customer-account";
import type { OrderId } from "@/features/order";
import { decodeBookedReservation } from "@/features/reservation/backend/booked-reservation";
import { getCoworkReservationInterval } from "@/features/reservation/cowork-reservation";
import { getCurrentWorkspaceDate } from "@/features/reservation/reservation-date";
import { ReservationAccessService } from "@/features/reservation-access";
import { WorkspaceDotyposLayer } from "@/shared/backend/config/dotypos.config";
import { runWorkspaceEffect } from "@/shared/backend/workspace-effect";
import { withWorkspaceRequestContext } from "@/shared/backend/workspace-request-context";
import { currentInstant, plainDateStringSchema } from "@/shared/utils/temporal";
import type { UnlimitedAccessView } from "../unlimited-access";
import { getUnlimitedPassAccessDay } from "../unlimited-pass-period";

const noPass = { state: "not-found" } as const;

const readPassAccess = Effect.fn("passes.unlimitedAccess.read")(function* (
  orderId: OrderId,
  accountId: CustomerAccountId,
  now: Temporal.Instant
) {
  const { db } = yield* WorkspaceDatabase;
  const date = getCurrentWorkspaceDate(now);
  const [access] = yield* db
    .select({
      tier: passPurchases.tier,
      status: passPurchases.status,
      validFrom: passPurchases.validFrom,
      validUntil: passPurchases.validUntil,
      accessEndsOn: passPurchases.accessEndsOn,
      reservation: {
        id: workspaceReservations.id,
        dotyposId: workspaceReservations.dotyposReservationId,
        tableId: workspaceReservations.passDayTableId,
      },
    })
    .from(passPurchases)
    .leftJoin(
      workspaceReservations,
      and(
        eq(workspaceReservations.passId, passPurchases.id),
        eq(
          workspaceReservations.serviceDate,
          plainDateStringSchema.make(date.toString())
        ),
        eq(workspaceReservations.paymentState, "paid"),
        eq(workspaceReservations.reservationState, "confirmed")
      )
    )
    .where(
      and(
        eq(passPurchases.id, orderId),
        eq(passPurchases.product, "unlimited"),
        eq(passPurchases.holderAccountId, accountId),
        or(
          eq(passPurchases.buyerAccountId, accountId),
          isNotNull(passPurchases.giftClaimedAt)
        )
      )
    )
    .limit(1);

  if (
    !access ||
    access.status === "pending_payment" ||
    access.status === "void"
  )
    return noPass;

  const { tier, validFrom, accessEndsOn, reservation, status } = access;
  const validUntil = accessEndsOn ?? access.validUntil;
  const period = { tier, validFrom, validUntil };
  const day = getUnlimitedPassAccessDay({ ...access, date });

  if (status === "active" && Temporal.PlainDate.compare(date, validFrom) < 0) {
    return { ...period, state: "before-start" } as const;
  }
  if (day === undefined) {
    return { ...period, state: "ended" } as const;
  }

  const interval = getCoworkReservationInterval(
    tier === "open-space" ? "open-space" : "reserved-desk",
    date.toString()
  );
  const bounds = {
    startsAt: Temporal.Instant.from(interval.startsAt),
    endsAt: Temporal.Instant.from(interval.endsAt),
  };
  const view = {
    ...period,
    date,
    day,
    continuesTomorrow:
      Temporal.PlainDate.compare(date.add({ days: 1 }), validUntil) < 0,
  };

  if (Temporal.Instant.compare(now, bounds.endsAt) >= 0) {
    return { ...view, state: "closed" } as const;
  }
  if (!reservation?.dotyposId) return { ...view, state: "retry" } as const;

  return {
    state: "open",
    view,
    bounds,
    reservationId: reservation.id,
    dotyposId: reservation.dotyposId,
    tableId: reservation.tableId,
  } as const;
});

export const loadUnlimitedAccess = Effect.fn("passes.unlimitedAccess.load")(
  function* (
    orderId: OrderId
  ): Effect.fn.Return<
    UnlimitedAccessView | typeof noPass | { readonly state: "sign-in" },
    Effect.Error<ReturnType<typeof readPassAccess>>,
    | WorkspaceDatabase
    | CurrentCustomerAccount
    | ReservationAccessService
    | DotyposService
  > {
    const account = yield* CurrentCustomerAccount;
    const session = yield* Effect.result(account.requireActive);
    if (Result.isFailure(session)) {
      if (session.failure.reason !== "unauthenticated") return noPass;
      const { db } = yield* WorkspaceDatabase;
      const [candidate] = yield* db
        .select({ id: passPurchases.id })
        .from(passPurchases)
        .where(
          and(
            eq(passPurchases.id, orderId),
            eq(passPurchases.product, "unlimited")
          )
        )
        .limit(1);
      return candidate ? { state: "sign-in" } : noPass;
    }

    const { accountId } = session.success;
    const access = yield* readPassAccess(
      orderId,
      accountId,
      yield* currentInstant
    );
    if (access.state !== "open") return access;

    const dotypos = yield* DotyposService;
    const read = yield* dotypos.getReservation(access.dotyposId).pipe(
      Effect.timeout("8 seconds"),
      Effect.orElseSucceed(() => Option.none())
    );
    const record = Option.getOrUndefined(read)?.reservation;
    const booked =
      record && Option.getOrUndefined(decodeBookedReservation(record).interval);
    if (
      record?.status !== "CONFIRMED" ||
      record._tableId !== access.tableId ||
      !booked?.startsAt.equals(access.bounds.startsAt) ||
      !booked.endsAt.equals(access.bounds.endsAt)
    ) {
      return { ...access.view, state: "retry" };
    }

    const deskLabel =
      access.view.tier === "open-space"
        ? undefined
        : yield* dotypos.getTables().pipe(
            Effect.map((tables) =>
              tables.find((table) => table.id === access.tableId)?.name?.trim()
            ),
            Effect.timeout("3 seconds"),
            Effect.orElseSucceed(() => undefined)
          );

    // Time and entitlement can change while the venue reads are in flight.
    const latest = yield* readPassAccess(
      orderId,
      accountId,
      yield* currentInstant
    );
    if (latest.state !== "open") return latest;
    if (latest.reservationId !== access.reservationId) {
      return { ...latest.view, state: "retry" };
    }

    const codes = yield* ReservationAccessService;
    const issued = yield* codes
      .issueForReservation({
        reservationId: access.reservationId,
        reservedFrom: access.bounds.startsAt,
        reservedUntil: access.bounds.endsAt,
      })
      .pipe(
        Effect.tapError(() =>
          Effect.logWarning("Unlimited pass access code could not be issued")
        ),
        Effect.option
      );

    const settled = yield* readPassAccess(
      orderId,
      accountId,
      yield* currentInstant
    );
    if (settled.state !== "open") return settled;
    if (
      settled.reservationId !== access.reservationId ||
      Option.isNone(issued)
    ) {
      return { ...settled.view, state: "retry" };
    }

    return {
      ...settled.view,
      state: "available",
      code: issued.value.accessCode,
      endsAt: access.bounds.endsAt,
      ...(deskLabel && { deskLabel }),
    };
  }
);

export const loadUnlimitedAccessPage = (
  orderId: OrderId,
  requestHeaders: Headers
) =>
  loadUnlimitedAccess(orderId).pipe(
    Effect.provide(
      Layer.mergeAll(
        WorkspaceDatabase.Default,
        CurrentCustomerAccount.Live,
        ReservationAccessService.Live,
        WorkspaceDotyposLayer
      )
    ),
    withWorkspaceRequestContext(requestHeaders),
    runWorkspaceEffect("passes.unlimitedAccess.load")
  );
