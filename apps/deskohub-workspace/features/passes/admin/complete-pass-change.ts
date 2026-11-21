import { DotyposService } from "@deskohub/dotypos";
import { and, asc, eq, gt, gte, isNull, lt, sql } from "drizzle-orm";
import { Effect, Result } from "effect";
import { WorkspaceDatabase, WorkspaceTransaction } from "@/db/database.service";
import {
  orders,
  passAdministrationChanges,
  passEntryClaims,
  passPurchases,
  unlimitedPassDayMoves,
  workspaceReservations,
} from "@/db/schema";
import { WorkspaceLockSections } from "@/db/workspace-locks";
import { findPurchaseLoginEmail } from "@/features/account/backend/customer-account-by-email";
import { ReservationAdministrationService } from "@/features/administration/reservation-administration.service";
import { workspaceBookingSeatCount } from "@/features/checkout/backend/reservation/workspace-table-occupancy";
import { getWorkspaceDate } from "@/features/reservation/reservation-date";
import {
  currentInstant,
  type PlainDate,
  plainDateStringSchema,
  temporalInstantToDate,
} from "@/shared/utils/temporal";
import { queueInitialEntryPackGift } from "../backend/entry-pack-gift";
import { pendingPassChange } from "../backend/pass-administration-pending";
import {
  attemptUnlimitedPassHolds,
  confirmUnlimitedPassDays,
  passDayHold,
  readUnlimitedPassDays,
  releaseUnlimitedPassDays,
} from "../backend/unlimited-pass-holds";
import { requireUnlimitedPassWindow } from "../backend/unlimited-pass-orders";
import { formatPassDayMarker } from "../pass-day-marker";
import { savePassHolder } from "./apply-pass-adjustment";
import { passValidityEnd } from "./pass-adjustments";
import { lockPassForChange, PassChangeRefused } from "./pass-change-records";

type ChangeRecord = typeof passAdministrationChanges.$inferSelect;
type Purchase = typeof passPurchases.$inferSelect;
type DayRange = { readonly from: PlainDate; readonly until: PlainDate };

const finishPassChange = Effect.fn("finishPassChange")(function* (
  record: ChangeRecord,
  status: "completed" | "failed"
) {
  const { db } = yield* WorkspaceTransaction;
  const now = yield* currentInstant;
  const [settled] = yield* db
    .update(passAdministrationChanges)
    .set(status === "completed" ? { completedAt: now } : { failedAt: now })
    .where(
      and(
        eq(passAdministrationChanges.requestId, record.requestId),
        pendingPassChange
      )
    )
    .returning();
  return settled ?? record;
});

const cancelPackBookings = Effect.fn("cancelPackBookings")(function* (
  record: ChangeRecord,
  sendCancellationEmail: boolean
) {
  const { db, transaction } = yield* WorkspaceDatabase;
  const reservations = yield* ReservationAdministrationService;
  const futureClaims = yield* db
    .select({ id: passEntryClaims.reservationId })
    .from(passEntryClaims)
    .where(
      and(
        eq(passEntryClaims.passId, record.passId),
        eq(passEntryClaims.status, "consumed"),
        gt(
          passEntryClaims.date,
          plainDateStringSchema.make(
            getWorkspaceDate(record.requestedAt).toString()
          )
        )
      )
    )
    .orderBy(asc(passEntryClaims.date));
  for (const { id } of futureClaims) {
    yield* reservations.cancel({
      reservationId: id,
      sendCancellationEmail,
      actor: {
        source: "admin-ui",
        administrator: {
          accountId: record.actorAccountId,
          email: record.actorAccountEmail,
        },
      },
    });
    yield* db
      .update(passEntryClaims)
      .set({ status: "released" })
      .where(
        and(
          eq(passEntryClaims.reservationId, id),
          eq(passEntryClaims.status, "consumed")
        )
      );
  }
  return yield* transaction(finishPassChange(record, "completed"));
});

const releasePassChangeDays = Effect.fn("releasePassChangeDays")(function* (
  purchase: Purchase,
  range: DayRange
) {
  if (range.from >= range.until) return true;
  const { db } = yield* WorkspaceDatabase;
  const [unsettledMove] = yield* db
    .select({ id: unlimitedPassDayMoves.reservationId })
    .from(unlimitedPassDayMoves)
    .innerJoin(
      workspaceReservations,
      eq(workspaceReservations.id, unlimitedPassDayMoves.reservationId)
    )
    .where(
      and(
        eq(workspaceReservations.passId, purchase.id),
        gte(workspaceReservations.serviceDate, range.from),
        lt(workspaceReservations.serviceDate, range.until),
        isNull(unlimitedPassDayMoves.settledAt)
      )
    )
    .limit(1);
  if (unsettledMove) return false;
  yield* releaseUnlimitedPassDays(purchase, range);
  const rows = yield* readUnlimitedPassDays(purchase.id);
  return rows.every(
    (row) =>
      row.serviceDate < range.from ||
      row.serviceDate >= range.until ||
      row.reservationState === "cancelled" ||
      row.reservationState === "hold_expired"
  );
});

const transferPassDays = Effect.fn("transferPassDays")(function* (
  record: ChangeRecord,
  purchase: Purchase,
  change: Extract<ChangeRecord["change"], { _tag: "reassign" }>
) {
  const { db, transaction } = yield* WorkspaceDatabase;
  const dotypos = yield* DotyposService;
  const newCustomerId = change.holderCustomerId;
  if (
    !newCustomerId ||
    purchase.holderAccountId !== change.expectedHolderAccountId ||
    purchase.status !== "active"
  ) {
    return yield* new PassChangeRefused({ reason: "changed" });
  }
  const now = yield* currentInstant;
  const rollback =
    getWorkspaceDate(now).toString() >= purchase.validFrom ||
    !(yield* findPurchaseLoginEmail(change.holderAccountId));
  const days = (yield* readUnlimitedPassDays(purchase.id)).filter(
    ({ serviceDate }) =>
      serviceDate >= purchase.validFrom && serviceDate < purchase.validUntil
  );
  const expectedDays = Temporal.PlainDate.from(purchase.validFrom).until(
    purchase.validUntil
  ).days;
  if (days.length !== expectedDays)
    return yield* new PassChangeRefused({ reason: "changed" });
  for (const row of days) {
    if (row.reservationState !== "confirmed" || !row.dotyposReservationId) {
      return yield* new PassChangeRefused({ reason: "changed" });
    }
    const hold = passDayHold(purchase, row);
    yield* dotypos.reassignReservationCustomerIfMatches({
      reservationId: row.dotyposReservationId,
      expectedBooking: {
        customerId: rollback ? newCustomerId : row.dotyposCustomerId,
        tableId: hold.day.tableId,
        seats: workspaceBookingSeatCount,
        startDate: temporalInstantToDate(
          Temporal.Instant.from(hold.day.interval.startsAt)
        ),
        endDate: temporalInstantToDate(
          Temporal.Instant.from(hold.day.interval.endsAt)
        ),
      },
      expectedNoteLine: formatPassDayMarker(
        hold.passId,
        hold.day.serviceDate,
        hold.generation
      ),
      customerId: rollback ? row.dotyposCustomerId : newCustomerId,
    });
  }
  return yield* transaction(
    Effect.gen(function* () {
      if (rollback) return yield* finishPassChange(record, "failed");
      const finalizedAt = yield* currentInstant;
      // Reconciliation reverses the provider changes if midnight passed while transferring.
      if (getWorkspaceDate(finalizedAt).toString() >= purchase.validFrom)
        return record;
      const { purchase: latest } = yield* lockPassForChange(record.passId);
      if (
        latest.status !== "active" ||
        latest.holderAccountId !== change.expectedHolderAccountId
      ) {
        return yield* new PassChangeRefused({ reason: "changed" });
      }
      yield* requireUnlimitedPassWindow({
        orderId: record.passId,
        holderAccountId: change.holderAccountId,
        validFrom: latest.validFrom,
        validUntil: latest.validUntil,
      });
      yield* db
        .update(workspaceReservations)
        .set({ dotyposCustomerId: newCustomerId, updatedAt: finalizedAt })
        .where(
          and(
            eq(workspaceReservations.passId, purchase.id),
            eq(workspaceReservations.reservationState, "confirmed")
          )
        );
      yield* savePassHolder(latest, change.holderAccountId, finalizedAt);
      return yield* finishPassChange(record, "completed");
    })
  );
});

const confirmPassChangeDays = Effect.fn("confirmPassChangeDays")(function* (
  record: ChangeRecord,
  purchase: Purchase,
  range: DayRange,
  paidAt: Temporal.Instant | null,
  grant: boolean
) {
  const { db, transaction } = yield* WorkspaceDatabase;
  const failure = yield* attemptUnlimitedPassHolds(purchase, range);
  const confirmed = failure
    ? false
    : yield* Effect.gen(function* () {
        yield* db
          .update(workspaceReservations)
          .set({
            reservationState: "confirming",
            fulfillmentState: "processing",
            ...(paidAt && { paidAt, paymentState: "paid" as const }),
            updatedAt: yield* currentInstant,
          })
          .where(
            and(
              eq(workspaceReservations.passId, record.passId),
              gte(workspaceReservations.serviceDate, range.from),
              lt(workspaceReservations.serviceDate, range.until),
              eq(workspaceReservations.reservationState, "held")
            )
          );
        return Result.isSuccess(
          yield* Effect.result(confirmUnlimitedPassDays(purchase, range))
        );
      });
  if (!confirmed) {
    const now = yield* currentInstant;
    const days = (yield* readUnlimitedPassDays(purchase.id)).filter(
      ({ serviceDate }) =>
        serviceDate >= range.from && serviceDate < range.until
    );
    const shouldRelease = days.some(
      (day) =>
        day.reservationState === "hold_expired" ||
        (day.reservationHoldExpiresAt &&
          Temporal.Instant.compare(now, day.reservationHoldExpiresAt) >= 0)
    );
    if (!shouldRelease || !(yield* releasePassChangeDays(purchase, range)))
      return record;
    return yield* transaction(
      Effect.gen(function* () {
        if (grant) {
          yield* db
            .update(passPurchases)
            .set({ status: "void" })
            .where(eq(passPurchases.id, record.passId));
          yield* db
            .update(orders)
            .set({
              fulfillmentState: "failed",
              fulfillmentFailedAt: now,
              fulfillmentFailureCode: "admin_pass_days_unavailable",
              updatedAt: now,
            })
            .where(eq(orders.id, record.passId));
        }
        return yield* finishPassChange(record, "failed");
      })
    );
  }
  return yield* transaction(
    Effect.gen(function* () {
      const { purchase: latest } = yield* lockPassForChange(record.passId);
      if (latest.status !== (grant ? "pending_payment" : "active")) {
        return yield* new PassChangeRefused({ reason: "changed" });
      }
      yield* requireUnlimitedPassWindow({
        orderId: record.passId,
        holderAccountId: latest.holderAccountId,
        validFrom: latest.validFrom,
        validUntil: range.until,
      });
      const now = yield* currentInstant;
      if (grant) {
        const [active] = yield* db
          .update(passPurchases)
          .set({
            status: "active",
            giftIssuedAt:
              latest.buyerAccountId === latest.holderAccountId ? null : now,
          })
          .where(eq(passPurchases.id, record.passId))
          .returning();
        yield* db
          .update(orders)
          .set({
            fulfillmentState: "fulfilled",
            fulfilledAt: now,
            updatedAt: now,
          })
          .where(eq(orders.id, record.passId));
        if (active) yield* queueInitialEntryPackGift(active, now);
      } else {
        yield* db
          .update(passPurchases)
          .set({ validUntil: range.until })
          .where(eq(passPurchases.id, record.passId));
      }
      return yield* finishPassChange(record, "completed");
    })
  );
});

export const completePassChange = Effect.fn("completePassChange")(function* (
  record: ChangeRecord
) {
  const { db, transaction } = yield* WorkspaceDatabase;
  return yield* Effect.gen(function* () {
    const [current] = yield* db
      .select()
      .from(passAdministrationChanges)
      .where(eq(passAdministrationChanges.requestId, record.requestId));
    if (!current || current.completedAt || current.failedAt)
      return current ?? record;
    const [pass] = yield* db
      .select({ purchase: passPurchases, paidAt: orders.paidAt })
      .from(passPurchases)
      .innerJoin(orders, eq(orders.id, passPurchases.id))
      .where(eq(passPurchases.id, current.passId));
    if (!pass) return yield* new PassChangeRefused({ reason: "not-found" });
    yield* db
      .update(passAdministrationChanges)
      .set({ lastAttemptAt: yield* currentInstant })
      .where(eq(passAdministrationChanges.requestId, record.requestId));
    const { purchase, paidAt } = pass;
    const { change } = current;
    switch (change._tag) {
      case "cancel": {
        if (purchase.product === "entry-pack") {
          return yield* cancelPackBookings(
            current,
            change.sendCancellationEmail
          );
        }
        if (!purchase.accessEndsOn)
          return yield* new PassChangeRefused({ reason: "changed" });
        if (
          yield* releasePassChangeDays(purchase, {
            from: purchase.accessEndsOn,
            until: purchase.validUntil,
          })
        ) {
          return yield* transaction(finishPassChange(current, "completed"));
        }
        return current;
      }
      case "grant":
        return yield* confirmPassChangeDays(
          current,
          purchase,
          { from: purchase.validFrom, until: purchase.validUntil },
          null,
          true
        );
      case "validity": {
        const end = passValidityEnd(change.lastDay);
        if (end > change.expectedValidUntil) {
          return yield* confirmPassChangeDays(
            current,
            purchase,
            { from: change.expectedValidUntil, until: end },
            paidAt,
            false
          );
        }
        if (
          yield* releasePassChangeDays(purchase, {
            from: end,
            until: change.expectedValidUntil,
          })
        ) {
          return yield* transaction(finishPassChange(current, "completed"));
        }
        return current;
      }
      case "reassign":
        return yield* transferPassDays(current, purchase, change);
    }
  }).pipe(
    WorkspaceLockSections.passPurchaseFulfillment(record.passId),
    WorkspaceLockSections.unlimitedPassRecovery(record.passId)
  );
});

export const reconcilePassChanges = Effect.fn("reconcilePassChanges")(
  function* (limit: number) {
    const { db } = yield* WorkspaceDatabase;
    const records = yield* db
      .select()
      .from(passAdministrationChanges)
      .where(pendingPassChange)
      .orderBy(
        asc(
          sql`coalesce(${passAdministrationChanges.lastAttemptAt}, ${passAdministrationChanges.requestedAt})`
        )
      )
      .limit(limit);
    for (const record of records) {
      yield* completePassChange(record).pipe(
        Effect.timeout("75 seconds"),
        Effect.catch(() =>
          Effect.logWarning("Pass administration change needs reconciliation", {
            passId: record.passId,
          })
        )
      );
    }
    return records.length;
  }
);
