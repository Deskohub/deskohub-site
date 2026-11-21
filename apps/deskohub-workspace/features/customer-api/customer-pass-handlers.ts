import {
  CustomerPassesUnavailable,
  CustomerPassNotFound,
  WorkspaceCustomerApi,
} from "@deskohub/workspace-customer-api";
import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { CustomerAuthentication } from "@/features/account/backend/customer-authentication.service";
import { defaultLocale } from "@/features/i18n";
import { orderIdSchema } from "@/features/order";
import {
  CustomerPassesClosed,
  HeldPassNotFound,
} from "@/features/passes/backend/customer-pass-reads";
import { CustomerPasses } from "@/features/passes/backend/customer-passes.service";
import { providePerRequest } from "@/shared/backend/provide-per-request";
import { runToCompletion } from "@/shared/backend/run-to-completion";
import {
  answerCustomerApiFailure,
  type CustomerAccountApiFailure,
} from "./customer-api-failure";
import { CustomerPassLayers } from "./customer-pass-layers";
import { CustomerReservationLayers } from "./customer-reservation-layers";

type PassReadFailure = CustomerAccountApiFailure | CustomerPassesUnavailable;

const failPassRequest = <E>(
  operation: string,
  failure: E
): Effect.Effect<never, PassReadFailure> =>
  failure instanceof CustomerPassesClosed
    ? Effect.fail(new CustomerPassesUnavailable())
    : answerCustomerApiFailure(operation)(Effect.fail<unknown>(failure));

const answerPassFailure =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.catch((failure) => failPassRequest(operation, failure)));

export const CustomerPassApiHandlers = HttpApiBuilder.group(
  WorkspaceCustomerApi,
  "passes",
  Effect.fn(function* (handlers) {
    const layers = yield* CustomerPassLayers;
    const reservations = yield* CustomerReservationLayers;
    const authentication = Layer.succeed(
      CustomerAuthentication,
      yield* CustomerAuthentication
    );
    const currentAccount = reservations.currentAccount.pipe(
      Layer.provide(authentication)
    );
    const shared = Layer.mergeAll(
      layers.passes,
      layers.release,
      currentAccount
    );
    const passReads = Layer.mergeAll(shared, layers.database);

    return handlers
      .handle("listPassOffers", () =>
        Effect.flatMap(CustomerPasses, (passes) => passes.catalog()).pipe(
          providePerRequest(shared),
          answerPassFailure("customerApi.listPassOffers")
        )
      )
      .handle("listPasses", ({ query: { locale = defaultLocale } }) =>
        Effect.flatMap(CustomerPasses, (passes) => passes.list(locale)).pipe(
          providePerRequest(Layer.mergeAll(passReads, layers.inventory)),
          runToCompletion,
          answerPassFailure("customerApi.listPasses")
        )
      )
      .handle("getPassBookingOptions", ({ query }) =>
        Effect.flatMap(CustomerPasses, (passes) => passes.options(query)).pipe(
          providePerRequest(passReads),
          runToCompletion,
          answerPassFailure("customerApi.getPassBookingOptions")
        )
      )
      .handle("getUnlimitedAccess", ({ params: { passId } }) =>
        Effect.flatMap(CustomerPasses, (passes) =>
          passes.todayCode(orderIdSchema.make(passId))
        ).pipe(
          providePerRequest(
            Layer.mergeAll(passReads, layers.accessCodes, layers.dotypos)
          ),
          runToCompletion,
          Effect.catch(
            (
              failure
            ): Effect.Effect<never, PassReadFailure | CustomerPassNotFound> =>
              failure instanceof HeldPassNotFound
                ? Effect.fail(new CustomerPassNotFound())
                : failPassRequest("customerApi.getUnlimitedAccess", failure)
          )
        )
      )
      .handle("getReservationPassFunding", ({ query: { orderIds } }) =>
        Effect.flatMap(CustomerPasses, (passes) =>
          passes.reservationFunding(orderIds)
        ).pipe(
          providePerRequest(passReads),
          answerPassFailure("customerApi.getReservationPassFunding")
        )
      );
  })
);
