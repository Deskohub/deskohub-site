import "server-only";

import { Effect, Layer } from "effect";
import { CustomerAccountReservationOwnership } from "@/features/account/backend/customer-account-reservation-ownership";
import { CustomerAuthentication } from "@/features/account/backend/customer-authentication.service";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import { SealedStateKeys } from "@/shared/backend/sealed-state-keys.service";
import { requirePayStateAuthor } from "./pay-state-author";

export const PublicReservationAuthor =
  CustomerAccountReservationOwnership.ForProvidedAuthentication.pipe(
    Layer.provide(CustomerAuthentication.Default)
  );

export const publicPayStateAuthorServices = Layer.mergeAll(
  PublicReservationAuthor,
  WorkspaceReservationRepository.Live,
  SealedStateKeys.Default
);

export const requirePublicPayStateAuthor = Effect.fn(
  "checkout.requirePublicPayStateAuthor"
)(function* (
  input: Omit<Parameters<typeof requirePayStateAuthor>[0], "accountId">
) {
  const ownership = yield* CustomerAccountReservationOwnership;
  const accountId = yield* ownership.activeAccountId;
  return yield* requirePayStateAuthor({ ...input, accountId });
});
