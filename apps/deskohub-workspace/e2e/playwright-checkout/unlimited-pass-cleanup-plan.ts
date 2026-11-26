import type {
  DotyposCustomerId,
  DotyposReservation,
  DotyposReservationId,
} from "@deskohub/dotypos";
import { Data, Schema } from "effect";
import type { WorkspaceReservationRow } from "@/db/schema/workspace-reservations";
import type { CustomerAccountId } from "@/features/account/customer-account";
import { type OrderId, orderIdSchema } from "@/features/order";
import {
  hasUnlimitedPassDayMarker,
  matchesUnlimitedPassDayHold,
} from "@/features/passes/backend/unlimited-pass-dotypos-holds";
import { ambiguousPassDayHoldCode } from "@/features/passes/pass-day-marker";
import { unlimitedPassDays } from "@/features/passes/pass-offer";
import { getCoworkReservationInterval } from "@/features/reservation/cowork-reservation";
import { workspaceSiteConstants } from "@/shared/utils/site-constants";
import type { WorkspaceE2EAccountLaneReconciliation } from "../account/reconcile";
import { getWorkspaceE2EDateInterval } from "../capacity";
import type { WorkspaceE2ERunId } from "../run-identifiers";
import { parseReservationIntents } from "../soak-ownership";
import { unlimitedPassAutoRenewalCaseId } from "./case-catalog";

export class UnlimitedPassCleanupBlocked extends Data.TaggedError(
  "UnlimitedPassCleanupBlocked"
)<{ readonly message: string }> {
  constructor(message: string) {
    super({ message });
  }
}

const invalidJournal = () =>
  new UnlimitedPassCleanupBlocked(
    "Unlimited pass journal ownership is incomplete"
  );

export const readUnlimitedPassCleanupIntent = ({
  account,
  runId,
  value,
}: {
  readonly account: WorkspaceE2EAccountLaneReconciliation | undefined;
  readonly runId: WorkspaceE2ERunId;
  readonly value: unknown;
}) => {
  const [intent, extra] = parseReservationIntents(
    value === undefined ? [] : value,
    { runId },
    [unlimitedPassAutoRenewalCaseId]
  );
  if (!intent) return undefined;
  const [authUserId] = account?.journal.authUserIds ?? [];
  const [dotyposCustomerId] = account?.dotyposCustomerIds ?? [];
  if (
    extra ||
    !(authUserId && dotyposCustomerId && account) ||
    account.journal.authUserIds.length !== 1 ||
    account.journal.dotyposCustomerIds.length !== 1 ||
    !("customerId" in intent.owner) ||
    intent.owner.customerId !== dotyposCustomerId ||
    intent.reservationId !== undefined ||
    typeof intent.requestedAt !== "string" ||
    (intent.paymentStartedAt !== undefined && !intent.orderId) ||
    (intent.paymentFulfilledAt !== undefined && !intent.paymentStartedAt)
  ) {
    throw invalidJournal();
  }

  const requestedAt = Date.parse(intent.requestedAt);
  const paymentStartedAt = intent.paymentStartedAt
    ? Date.parse(intent.paymentStartedAt)
    : undefined;
  const paymentFulfilledAt = intent.paymentFulfilledAt
    ? Date.parse(intent.paymentFulfilledAt)
    : undefined;
  if (
    !Number.isFinite(requestedAt) ||
    (paymentStartedAt !== undefined && !(paymentStartedAt >= requestedAt)) ||
    (paymentFulfilledAt !== undefined &&
      !(
        paymentStartedAt !== undefined && paymentFulfilledAt >= paymentStartedAt
      ))
  ) {
    throw invalidJournal();
  }

  const firstDay = Temporal.Instant.from(intent.startDate)
    .toZonedDateTimeISO(workspaceSiteConstants.location.timeZone)
    .toPlainDate();
  const endsBefore = firstDay.add({ days: unlimitedPassDays });
  const interval = getWorkspaceE2EDateInterval({
    fromDate: firstDay.toString(),
    toDate: endsBefore.subtract({ days: 1 }).toString(),
  });
  if (
    interval.startDate.toISOString() !== intent.startDate ||
    interval.endDate.toISOString() !== intent.endDate
  ) {
    throw invalidJournal();
  }
  return {
    accountId: authUserId as CustomerAccountId,
    customerId: dotyposCustomerId as DotyposCustomerId,
    endsBefore,
    firstDay,
    interval,
    orderId: intent.orderId
      ? Schema.decodeUnknownSync(orderIdSchema)(intent.orderId)
      : undefined,
    paymentStarted: paymentStartedAt !== undefined,
    requestedAt,
  };
};

export type UnlimitedPassCleanupIntent = NonNullable<
  ReturnType<typeof readUnlimitedPassCleanupIntent>
>;

type PassDayCleanupRow = Pick<
  WorkspaceReservationRow,
  | "authorAccountId"
  | "dotyposCustomerId"
  | "dotyposReservationId"
  | "failureCode"
  | "id"
  | "passDayHoldGeneration"
  | "passDayHoldRequestedAt"
  | "passDayTableId"
  | "passId"
  | "reservationState"
  | "serviceDate"
>;

const passDay = (row: PassDayCleanupRow, serviceDate: Temporal.PlainDate) => {
  if (!row.passDayTableId) {
    throw new UnlimitedPassCleanupBlocked("Unlimited pass day has no table");
  }
  return {
    serviceDate,
    tableId: row.passDayTableId,
    interval: getCoworkReservationInterval(
      "open-space",
      serviceDate.toString()
    ),
  };
};

export const isUnlimitedPassDayReleased = (
  row: Pick<PassDayCleanupRow, "reservationState">
) =>
  row.reservationState === "cancelled" ||
  row.reservationState === "hold_expired";

/** The provider inventory is already limited to the order's exact markers. */
export const planUnlimitedPassDayRelease = ({
  intent: { accountId, customerId, firstDay },
  orderId,
  records,
  rows,
}: {
  readonly intent: Pick<
    UnlimitedPassCleanupIntent,
    "accountId" | "customerId" | "firstDay"
  >;
  readonly orderId: OrderId;
  readonly records: readonly DotyposReservation[];
  readonly rows: readonly PassDayCleanupRow[];
}) => {
  if (rows.length !== unlimitedPassDays) {
    throw new UnlimitedPassCleanupBlocked(
      "Unlimited pass calendar is incomplete"
    );
  }
  const providerIds = new Set<DotyposReservationId>();
  const days = rows.map((row, offset) => {
    const serviceDate = firstDay.add({ days: offset });
    if (
      row.passId !== orderId ||
      row.serviceDate !== serviceDate.toString() ||
      row.authorAccountId !== accountId ||
      row.dotyposCustomerId !== customerId
    ) {
      throw new UnlimitedPassCleanupBlocked(
        "Unlimited pass day ownership did not match"
      );
    }
    if (
      row.failureCode === ambiguousPassDayHoldCode &&
      !isUnlimitedPassDayReleased(row)
    ) {
      throw new UnlimitedPassCleanupBlocked(
        "Unlimited pass has a recorded ambiguous hold"
      );
    }
    const booking = {
      passId: orderId,
      customerId,
      day: passDay(row, serviceDate),
      generation: row.passDayHoldGeneration,
    };
    const marked = records.filter((record) =>
      hasUnlimitedPassDayMarker(
        record,
        orderId,
        serviceDate,
        row.passDayHoldGeneration
      )
    );
    const [record] = marked;
    if (
      marked.length > 1 ||
      (record &&
        (!record.id ||
          providerIds.has(record.id) ||
          !row.passDayHoldRequestedAt ||
          (row.dotyposReservationId &&
            row.dotyposReservationId !== record.id) ||
          !matchesUnlimitedPassDayHold(record, booking) ||
          (record.status !== "NEW" &&
            record.status !== "CONFIRMED" &&
            record.status !== "CANCELLED")))
    ) {
      throw new UnlimitedPassCleanupBlocked(
        "Unlimited pass provider ownership is ambiguous"
      );
    }
    if (record?.id) providerIds.add(record.id);
    return {
      booking,
      record,
      reservationId: record?.id ?? row.dotyposReservationId ?? undefined,
      row,
    };
  });
  if (
    records.some(
      ({ id, status }) => status !== "CANCELLED" && !providerIds.has(id)
    )
  ) {
    throw new UnlimitedPassCleanupBlocked(
      "Unlimited pass inventory contains an unproven hold"
    );
  }
  return days;
};
