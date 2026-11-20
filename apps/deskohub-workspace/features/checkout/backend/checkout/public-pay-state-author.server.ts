import "server-only";

import { Effect, Layer } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { CustomerAccountReservationOwnership } from "@/features/account/backend/customer-account-reservation-ownership";
import { CustomerAuthentication } from "@/features/account/backend/customer-authentication.service";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import { reservationOrderId } from "@/features/reservation/persistence-contracts";
import { SealedStateKeys } from "@/shared/backend/sealed-state-keys.service";
import { currentPreciseInstant } from "@/shared/utils/temporal";
import type { FioReceivingAccountDisplay } from "../fio/fio-accounts.service";
import { QrPaymentRepository } from "../repositories/qr-payment.repository";
import { requirePayStateAuthor } from "./pay-state-author";
import { isOrderBoundPayState } from "./pay-state-contract";
import { getPublicReservationPaymentAccount } from "./public-reservation-payment-account";

export const PublicReservationAuthor =
  CustomerAccountReservationOwnership.ForProvidedAuthentication.pipe(
    Layer.provide(CustomerAuthentication.Default)
  );

export const publicPayStateAuthorServices = Layer.mergeAll(
  PublicReservationAuthor,
  WorkspaceReservationRepository.Live,
  QrPaymentRepository.Default.pipe(Layer.provide(WorkspaceDatabase.Default)),
  SealedStateKeys.Default
);

export const readPublicPayStatePaymentAccount = Effect.fn(
  "checkout.readPublicPayStatePaymentAccount"
)(function* (
  input: Omit<Parameters<typeof requirePayStateAuthor>[0], "accountId">,
  defaultAccount: FioReceivingAccountDisplay
) {
  const ownership = yield* CustomerAccountReservationOwnership;
  const accountId = yield* ownership.activeAccountId;
  const state = yield* requirePayStateAuthor({ ...input, accountId });
  if (
    isOrderBoundPayState(state) ||
    state.changedKeys ||
    state.acceptedTotal.currency !== "CZK" ||
    state.acceptedTotal.value <= 0
  )
    return undefined;

  const reservations = yield* WorkspaceReservationRepository;
  const reservation = yield* reservations.findById(state.orderId);
  if (
    !reservation ||
    reservation.authorAccountId !== accountId ||
    reservation.agentClientId ||
    reservation.reservationState !== "held"
  )
    return undefined;

  const payments = yield* QrPaymentRepository;
  const window = yield* payments.findPaymentWindow(
    reservationOrderId(state.orderId)
  );
  if (window) {
    const now = yield* currentPreciseInstant;
    if (
      reservation.paymentState !== "pending" ||
      Temporal.Instant.compare(window.expiresAt, now) <= 0
    )
      return undefined;
    return yield* getPublicReservationPaymentAccount(window.accountKey);
  }

  // A payment started before QR was available stays on its original path.
  return reservation.paymentState === "not_started" &&
    !reservation.activePaymentAttemptId
    ? defaultAccount
    : undefined;
});
