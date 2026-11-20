import { randomUUID } from "node:crypto";
import { Context, Data, Duration, Effect, Layer } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import type { DatabaseQueryError } from "@/db/sql-constraint";
import { FioPaymentSettlementService } from "@/features/checkout/backend/payment/fio-payment-settlement.service";
import { QrPaymentRepository } from "@/features/checkout/backend/repositories/qr-payment.repository";
import { QueueRedelivery } from "@/shared/backend/queue/queue-consumer";
import {
  type QueueMessageSendError,
  QueuePublisher,
} from "@/shared/backend/queue/queue-publisher";
import { currentInstant } from "@/shared/utils";
import { FioAccountPollRepository } from "./fio-account-poll.repository";
import { FioAccounts, type FioReceivingAccount } from "./fio-accounts.service";
import { FioMovements } from "./fio-movements.service";
import {
  type FioPollJob,
  fioPollDeliveryExpiry,
  publishFioPollJob,
} from "./fio-poll-wake.service";

const pollSpacingSeconds = 35;
// Keep the queue route's maxDuration in sync. Even a worker killed right at
// that limit leaves time for the token cooldown before another read can start.
const interruptedReadSpacingSeconds = 60 + pollSpacingSeconds;

class FioPollNotDue extends Data.TaggedError("FioPollNotDue")<{
  readonly instant: Temporal.Instant;
}> {}

class FioPollUnavailable extends Data.TaggedError("FioPollUnavailable")<{
  readonly reason:
    | "account_unconfigured"
    | "inaccessible_history"
    | "invalid_period"
    | "provider_rejected"
    | "provider_unavailable";
}> {}

type PollError =
  | DatabaseQueryError
  | QueueMessageSendError
  | FioPollNotDue
  | FioPollUnavailable
  | Effect.Error<
      ReturnType<FioPaymentSettlementService["Service"]["recordMovement"]>
    >;

interface IFioAccountPoller {
  readonly consume: (job: FioPollJob) => Effect.Effect<void, PollError>;
}

interface PollRead {
  readonly readId: string;
  readonly receivingAccount: FioReceivingAccount;
  readonly from: string;
  readonly to: string;
}

export class FioAccountPoller extends Context.Service<
  FioAccountPoller,
  IFioAccountPoller
>()("FioAccountPoller") {
  static Default = Layer.effect(
    this,
    Effect.gen(function* () {
      const { transaction } = yield* WorkspaceDatabase;
      const polls = yield* FioAccountPollRepository;
      const accounts = yield* FioAccounts;
      const attempts = yield* QrPaymentRepository;
      const provider = yield* FioMovements;
      const settlements = yield* FioPaymentSettlementService;
      const publisher = yield* QueuePublisher;

      const claim = Effect.fn("FioAccountPoller.claim")(function* (
        job: FioPollJob
      ) {
        return yield* transaction(
          Effect.gen(function* () {
            const { accountKey, deliveryId } = job;
            const poll = yield* polls.lockDelivery(accountKey);
            if (poll?.deliveryId !== deliveryId) return;

            if (!(yield* attempts.hasPayableAttempts(accountKey))) {
              yield* polls.update(accountKey, idleDelivery);
              return;
            }

            const now = yield* polls.currentTime(accountKey);
            if (
              poll.readNotBefore &&
              poll.readNotBefore.getTime() > now.epochMilliseconds
            ) {
              return yield* new FioPollNotDue({
                instant: Temporal.Instant.fromEpochMilliseconds(
                  poll.readNotBefore.getTime()
                ),
              });
            }

            const receivingAccount = accounts.getReceivingAccount(accountKey);
            if (!receivingAccount) {
              return yield* new FioPollUnavailable({
                reason: "account_unconfigured",
              });
            }

            const to = now
              .toZonedDateTimeISO("Europe/Prague")
              .toPlainDate()
              .toString();
            // An inclusive start on the last successful date replays the boundary
            // day. On the first read, retain the initial demand date across retries.
            const from = poll.coveredThrough ?? poll.firstDemandDate;
            if (from > to)
              return yield* new FioPollUnavailable({
                reason: "invalid_period",
              });

            const readId = randomUUID();
            yield* polls.update(accountKey, {
              readId,
              readNotBefore: new Date(
                now.add({ seconds: interruptedReadSpacingSeconds })
                  .epochMilliseconds
              ),
              deliveryExpiresAt: fioPollDeliveryExpiry(now),
            });
            return { readId, receivingAccount, from, to } satisfies PollRead;
          })
        );
      });

      const finish = Effect.fn("FioAccountPoller.finish")(function* (
        job: FioPollJob,
        read: PollRead
      ) {
        yield* transaction(
          Effect.gen(function* () {
            const { accountKey } = job;
            const poll = yield* polls.lock(accountKey);
            if (
              poll?.deliveryId !== job.deliveryId ||
              poll.readId !== read.readId
            )
              return;

            const payable = yield* attempts.hasPayableAttempts(accountKey);
            const now = yield* polls.currentTime(accountKey);
            const coverage = {
              coveredThrough: read.to,
              readNotBefore: new Date(
                now.add({ seconds: pollSpacingSeconds }).epochMilliseconds
              ),
            };
            if (!payable) {
              yield* polls.update(accountKey, { ...coverage, ...idleDelivery });
              return;
            }

            const deliveryId = randomUUID();
            yield* polls.update(accountKey, {
              ...coverage,
              deliveryId,
              deliveryExpiresAt: fioPollDeliveryExpiry(now),
              readId: null,
            });
            yield* publishFioPollJob(
              { accountKey, deliveryId },
              Duration.seconds(pollSpacingSeconds)
            ).pipe(Effect.provideService(QueuePublisher, publisher));
          })
        );
      });

      return {
        consume: Effect.fn("FioAccountPoller.consume")(function* (job) {
          const read = yield* claim(job);
          if (!read) return;

          const { account, readToken } = read.receivingAccount;
          const movements = yield* provider
            .readPeriod({ account, readToken, from: read.from, to: read.to })
            .pipe(
              Effect.mapError(
                (error) =>
                  new FioPollUnavailable({
                    reason: providerFailureReasons[error._tag],
                  })
              )
            );
          const observedAt = yield* currentInstant;
          if (
            movements.some(
              ({ bookingDate }) =>
                bookingDate < read.from || bookingDate > read.to
            )
          ) {
            return yield* new FioPollUnavailable({ reason: "invalid_period" });
          }

          // Settlement owns deduplication by account and movement ID. Commit
          // coverage only after all movement effects have succeeded.
          yield* Effect.forEach(
            movements,
            (movement) =>
              settlements.recordMovement({
                accountKey: job.accountKey,
                movementId: movement.movementId,
                bookingDate: Temporal.PlainDate.from(movement.bookingDate),
                observedAt,
                amount: movement.amount,
                ...(movement.reference._tag === "VariableSymbol"
                  ? { variableSymbol: movement.reference.value }
                  : {
                      variableSymbol: null,
                      referenceStatus:
                        movement.reference._tag === "Absent"
                          ? ("absent" as const)
                          : ("invalid" as const),
                    }),
              }),
            { discard: true }
          );
          yield* finish(job, read);
        }).pipe(
          Effect.tapError((error) =>
            error._tag === "FioPollUnavailable"
              ? Effect.logWarning(pollFailureMessages[error.reason])
              : Effect.void
          )
        ),
      };
    })
  );
}

const idleDelivery = {
  deliveryId: null,
  deliveryExpiresAt: null,
  readId: null,
};

const providerFailureReasons = {
  FioHistoryAccessRequired: "inaccessible_history",
  FioRejected: "provider_rejected",
  FioUnavailable: "provider_unavailable",
} as const;

const pollFailureMessages = {
  account_unconfigured:
    "Fio poll could not resolve its receiving account. Check Workspace FIO_RECEIVING_ACCOUNTS configuration.",
  inaccessible_history:
    "Fio poll cannot access its checkpoint range. Authorize historical account access in Fio and let the active poll retry.",
  invalid_period:
    "Fio poll received an inconsistent booking-date range. Check the provider response and the account checkpoint.",
  provider_rejected:
    "Fio rejected the polling request. Check the receiving account and read token configuration.",
  provider_unavailable:
    "Fio polling request failed. The queue will retry while payable demand remains.",
} as const;

export const fioPollRedelivery = (error: PollError): QueueRedelivery =>
  error._tag === "FioPollNotDue"
    ? QueueRedelivery.At({ instant: error.instant })
    : QueueRedelivery.WithBackoff();
