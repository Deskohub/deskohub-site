import "server-only";

import { type DotyposReservation, DotyposService } from "@deskohub/dotypos";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { Array as EffectArray, Data, Effect, Result } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import {
  type passPurchases,
  type WorkspaceReservationRow,
  workspaceReservations,
} from "@/db/schema";
import type { OrderId } from "@/features/order";
import { getCoworkReservationInterval } from "@/features/reservation/cowork-reservation";
import { currentInstant } from "@/shared/utils/temporal";
import { type PassTier, unlimitedPassDays } from "../pass-offer";
import {
  createUnlimitedPassDayHold,
  listUnlimitedPassDayHolds,
  matchesUnlimitedPassDayHold,
} from "./unlimited-pass-dotypos-holds";

export class UnlimitedPassHoldsUnavailable extends Data.TaggedError(
  "UnlimitedPassHoldsUnavailable"
)<{ readonly reason: "expired" | "unfinished" | "changed" }> {}

type PassDay = WorkspaceReservationRow & {
  readonly serviceDate: NonNullable<WorkspaceReservationRow["serviceDate"]>;
  readonly passDayTableId: NonNullable<
    WorkspaceReservationRow["passDayTableId"]
  >;
};

export const readUnlimitedPassDays = Effect.fn("readUnlimitedPassDays")(
  function* (orderId: OrderId) {
    const { db } = yield* WorkspaceDatabase;
    const rows = yield* db
      .select()
      .from(workspaceReservations)
      .where(eq(workspaceReservations.passId, orderId))
      .orderBy(asc(workspaceReservations.serviceDate));
    return rows.filter(
      (row): row is PassDay =>
        row.serviceDate !== null && row.passDayTableId !== null
    );
  }
);

type Purchase = typeof passPurchases.$inferSelect;

const providerDay = (row: PassDay, tier: PassTier) => ({
  serviceDate: Temporal.PlainDate.from(row.serviceDate),
  tableId: row.passDayTableId,
  interval: getCoworkReservationInterval(
    tier === "open-space" ? tier : "reserved-desk",
    row.serviceDate
  ),
});

/** Check the issued day rows again in the payment admission transaction. */
export const readPayableUnlimitedHolds = Effect.fn("readPayableUnlimitedHolds")(
  function* (
    purchase: Pick<Purchase, "id" | "status" | "validFrom" | "holdsExpireAt">
  ) {
    const now = yield* currentInstant;
    if (
      !purchase.holdsExpireAt ||
      Temporal.Instant.compare(now, purchase.holdsExpireAt) >= 0
    ) {
      return yield* new UnlimitedPassHoldsUnavailable({ reason: "expired" });
    }
    if (purchase.status !== "pending_payment") {
      return yield* new UnlimitedPassHoldsUnavailable({ reason: "changed" });
    }
    const rows = yield* readUnlimitedPassDays(purchase.id);
    const start = Temporal.PlainDate.from(purchase.validFrom);
    const holds = rows.flatMap((row, index) =>
      row.reservationState === "held" &&
      row.serviceDate === start.add({ days: index }).toString() &&
      row.dotyposReservationId &&
      row.reservationHoldExpiresAt &&
      Temporal.Instant.compare(now, row.reservationHoldExpiresAt) < 0
        ? [{ ...row, dotyposReservationId: row.dotyposReservationId }]
        : []
    );
    if (rows.length !== unlimitedPassDays || holds.length !== rows.length) {
      return yield* new UnlimitedPassHoldsUnavailable({ reason: "unfinished" });
    }
    return holds;
  }
);

/** Provider confirmation happens before sending a payment request. */
export const reconfirmUnlimitedPassHolds = Effect.fn(
  "reconfirmUnlimitedPassHolds"
)(function* (
  purchase: Pick<
    Purchase,
    "id" | "status" | "validFrom" | "holdsExpireAt" | "tier"
  >
) {
  const holds = yield* readPayableUnlimitedHolds(purchase);
  const dotypos = yield* DotyposService;
  const provider = yield* dotypos.getReservationsByIds(
    holds.map((hold) => hold.dotyposReservationId),
    { concurrency: 1 }
  );
  if (
    holds.some((hold) => {
      const reservation = provider.get(hold.dotyposReservationId);
      return (
        reservation?.status !== "NEW" ||
        !matchesUnlimitedPassDayHold(reservation, {
          passId: purchase.id,
          customerId: hold.dotyposCustomerId,
          day: providerDay(hold, purchase.tier),
        })
      );
    })
  ) {
    return yield* new UnlimitedPassHoldsUnavailable({ reason: "changed" });
  }
});

const readMarkedHolds = Effect.fnUntraced(function* (
  purchase: Purchase,
  rows: readonly WorkspaceReservationRow[]
) {
  const first = rows[0];
  if (!first || !rows.some((day) => day.passDayHoldRequestedAt)) return [];
  return yield* listUnlimitedPassDayHolds({
    passId: purchase.id,
    customerId: first.dotyposCustomerId,
    startDate: Temporal.PlainDate.from(purchase.validFrom),
  });
});

/** Runs inside the pass-order section after the local intent transaction commits. */
export const createUnlimitedPassHolds = Effect.fn("createUnlimitedPassHolds")(
  function* (purchase: Purchase) {
    const { db } = yield* WorkspaceDatabase;
    const rows = yield* readUnlimitedPassDays(purchase.id);
    if (
      rows.length !== unlimitedPassDays ||
      purchase.status !== "pending_payment"
    ) {
      return yield* new UnlimitedPassHoldsUnavailable({ reason: "unfinished" });
    }
    const remote = yield* readMarkedHolds(
      purchase,
      rows.filter((row) => !row.dotyposReservationId)
    );
    const attachHold = Effect.fnUntraced(function* (row: PassDay) {
      if (row.reservationState === "held" && row.dotyposReservationId) return;
      if (row.reservationState !== "creating_hold") {
        return yield* new UnlimitedPassHoldsUnavailable({
          reason: "changed",
        });
      }
      const now = yield* currentInstant;
      if (
        !row.reservationHoldExpiresAt ||
        Temporal.Instant.compare(now, row.reservationHoldExpiresAt) >= 0
      ) {
        return yield* new UnlimitedPassHoldsUnavailable({
          reason: "expired",
        });
      }
      const hold = {
        passId: purchase.id,
        customerId: row.dotyposCustomerId,
        day: providerDay(row, purchase.tier),
      };
      let attached: DotyposReservation;
      if (row.passDayHoldRequestedAt) {
        const matches = remote.filter(
          (record) =>
            record.status === "NEW" && matchesUnlimitedPassDayHold(record, hold)
        );
        if (matches.length !== 1 || !matches[0]) {
          return yield* new UnlimitedPassHoldsUnavailable({
            reason: "unfinished",
          });
        }
        attached = matches[0];
      } else {
        const [claimed] = yield* db
          .update(workspaceReservations)
          .set({ passDayHoldRequestedAt: now, updatedAt: now })
          .where(
            and(
              eq(workspaceReservations.id, row.id),
              eq(workspaceReservations.reservationState, "creating_hold"),
              isNull(workspaceReservations.passDayHoldRequestedAt)
            )
          )
          .returning({ id: workspaceReservations.id });
        if (!claimed)
          return yield* new UnlimitedPassHoldsUnavailable({
            reason: "changed",
          });
        attached = yield* createUnlimitedPassDayHold({
          ...hold,
          coffee:
            purchase.tier !== "open-space" || purchase.unlimitedCoffee === true,
        });
      }
      if (
        attached.status !== "NEW" ||
        !matchesUnlimitedPassDayHold(attached, hold)
      ) {
        return yield* new UnlimitedPassHoldsUnavailable({
          reason: "changed",
        });
      }
      yield* db
        .update(workspaceReservations)
        .set({
          dotyposReservationId: attached.id,
          reservationState: "held",
          reservationCreatedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(workspaceReservations.id, row.id),
            eq(workspaceReservations.reservationState, "creating_hold")
          )
        );
    });
    for (const pair of EffectArray.chunksOf(rows, 2)) {
      const outcomes = yield* Effect.forEach(
        pair,
        (row) => Effect.result(attachHold(row)),
        { concurrency: 2 }
      );
      const failure = outcomes.find(Result.isFailure);
      if (failure) return yield* failure.failure;
    }
  }
);

/** Keeps uncertain POST claims allocated until a matching provider record is observed. */
export const releaseUnlimitedPassDays = Effect.fn("releaseUnlimitedPassDays")(
  function* (purchase: Purchase) {
    const { db } = yield* WorkspaceDatabase;
    const dotypos = yield* DotyposService;
    const rows = (yield* readUnlimitedPassDays(purchase.id)).filter(
      (day) =>
        day.reservationState !== "cancelled" &&
        day.reservationState !== "hold_expired" &&
        day.serviceDate !== null &&
        (!purchase.accessEndsOn || day.serviceDate >= purchase.accessEndsOn)
    );
    const remote = yield* readMarkedHolds(purchase, rows);
    yield* Effect.forEach(
      rows,
      Effect.fnUntraced(
        function* (row: PassDay) {
          const now = yield* currentInstant;
          const matches = remote.filter((record) =>
            matchesUnlimitedPassDayHold(record, {
              passId: purchase.id,
              customerId: row.dotyposCustomerId,
              day: providerDay(row, purchase.tier),
            })
          );
          const ids = [
            ...new Set([
              ...(row.dotyposReservationId ? [row.dotyposReservationId] : []),
              ...matches.map(({ id }) => id),
            ]),
          ];
          if (!ids.length && row.passDayHoldRequestedAt) return;
          for (const id of ids) {
            if (
              matches.some(
                (record) => record.id === id && record.status === "CANCELLED"
              )
            )
              continue;
            yield* dotypos.cancelReservation(id);
          }
          const releasedId = ids[0];
          yield* db
            .update(workspaceReservations)
            .set({
              reservationState: releasedId ? "cancelled" : "hold_expired",
              ...(releasedId && {
                dotyposReservationId: releasedId,
                reservationCancelledAt: now,
              }),
              reservationHoldExpiredAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(workspaceReservations.id, row.id),
                inArray(workspaceReservations.reservationState, [
                  "creating_hold",
                  "held",
                  "confirming",
                  "confirmed",
                  "cancelling",
                  "cancellation_failed",
                ])
              )
            );
        },
        Effect.catch(() =>
          Effect.logWarning("Unlimited pass day release needs reconciliation")
        )
      ),
      { concurrency: 2, discard: true }
    );
  }
);

/** Confirms each stable day idempotently before the entitlement is activated. */
export const confirmUnlimitedPassDays = Effect.fn("confirmUnlimitedPassDays")(
  function* (purchase: Purchase) {
    const { db } = yield* WorkspaceDatabase;
    const dotypos = yield* DotyposService;
    const rows = yield* readUnlimitedPassDays(purchase.id);
    if (
      rows.length !== unlimitedPassDays ||
      rows.some((day) => day.paymentState !== "paid")
    ) {
      return yield* new UnlimitedPassHoldsUnavailable({ reason: "unfinished" });
    }
    yield* Effect.forEach(
      rows,
      Effect.fnUntraced(function* (row: PassDay) {
        if (
          row.reservationState === "confirmed" &&
          row.fulfillmentState === "fulfilled"
        )
          return;
        if (
          row.reservationState !== "confirming" ||
          !row.dotyposReservationId
        ) {
          return yield* new UnlimitedPassHoldsUnavailable({
            reason: "unfinished",
          });
        }
        const confirmed = yield* dotypos.confirmReservation(
          row.dotyposReservationId
        );
        if (
          confirmed.status !== "CONFIRMED" ||
          !matchesUnlimitedPassDayHold(confirmed, {
            passId: purchase.id,
            customerId: row.dotyposCustomerId,
            day: providerDay(row, purchase.tier),
          })
        ) {
          return yield* new UnlimitedPassHoldsUnavailable({
            reason: "changed",
          });
        }
        const now = yield* currentInstant;
        yield* db
          .update(workspaceReservations)
          .set({
            reservationState: "confirmed",
            fulfillmentState: "fulfilled",
            reservationConfirmedAt: now,
            fulfilledAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(workspaceReservations.id, row.id),
              eq(workspaceReservations.reservationState, "confirming"),
              eq(
                workspaceReservations.dotyposReservationId,
                row.dotyposReservationId
              )
            )
          );
      }),
      { concurrency: 2, discard: true }
    );
  }
);
