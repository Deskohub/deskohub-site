import { Context, Data, Effect, Layer, Option } from "effect";
import type { SqlError } from "effect/unstable/sql";
import { WorkspaceDatabaseAdvisoryLock } from "@/db/postgres-advisory-lock";
import { WorkspaceLockSections } from "@/db/workspace-locks";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";

/**
 * The order whose lock the enclosing section holds. Only a section provides
 * it, so a step that declares it in its requirements can only run while no
 * other workflow changes that order's hold or starts its payment.
 */
export class HeldReservationOrder extends Context.Service<
  HeldReservationOrder,
  { readonly orderId: WorkspaceReservationId }
>()("@deskohub-workspace/reservation/HeldReservationOrder") {}

/** The order's lock could not be taken; the work did not run. */
export class ReservationOrderSectionUnavailableError extends Data.TaggedError(
  "ReservationOrderSectionUnavailableError"
)<{
  readonly orderId: WorkspaceReservationId;
  readonly cause: SqlError.SqlError;
}> {}

interface IReservationOrderSections {
  /**
   * Runs `section` holding the order's lock on its own connection, with
   * `HeldReservationOrder` provided. Enter it outside every Workspace
   * transaction and inside any account section, never around one; the
   * section's writers open their own transactions.
   *
   * Inside a section that already holds this order, it runs `section` under
   * that hold, with no second lock.
   *
   * The lock's own failure is `ReservationOrderSectionUnavailableError`; the
   * section's failures pass through unchanged.
   */
  readonly withOrder: <A, E, R>(
    orderId: WorkspaceReservationId,
    section: Effect.Effect<A, E, R>
  ) => Effect.Effect<
    A,
    E | ReservationOrderSectionUnavailableError,
    Exclude<R, HeldReservationOrder>
  >;
}

export class ReservationOrderSections extends Context.Service<
  ReservationOrderSections,
  IReservationOrderSections
>()("@deskohub-workspace/reservation/ReservationOrderSections") {
  static Default = Layer.effect(
    this,
    Effect.gen(function* () {
      const advisoryLock = yield* WorkspaceDatabaseAdvisoryLock;

      /**
       * The lock's own SqlError is the only failure the registry adds. The
       * work's failures cross the lock wrapped, so a SqlError of the work is
       * never taken for the lock's.
       */
      const holdOrder = <A, E, R>(
        orderId: WorkspaceReservationId,
        work: Effect.Effect<A, E, R>
      ): Effect.Effect<A, E | ReservationOrderSectionUnavailableError, R> =>
        WorkspaceLockSections.reservationOrder(orderId)(
          work.pipe(Effect.mapError((error) => new SectionFailure({ error })))
        ).pipe(
          Effect.provideService(WorkspaceDatabaseAdvisoryLock, advisoryLock),
          Effect.catchTag("SqlError", (cause) =>
            Effect.fail(
              new ReservationOrderSectionUnavailableError({ orderId, cause })
            )
          ),
          Effect.catchTag("ReservationOrderSectionFailure", (failure) =>
            Effect.fail(failure.error)
          )
        );

      const withOrder: IReservationOrderSections["withOrder"] = (
        orderId,
        section
      ) =>
        Effect.flatMap(
          Effect.serviceOption(HeldReservationOrder),
          (enclosing) =>
            Option.isSome(enclosing) && enclosing.value.orderId === orderId
              ? Effect.provideService(
                  section,
                  HeldReservationOrder,
                  enclosing.value
                )
              : holdOrder(
                  orderId,
                  Effect.provideService(section, HeldReservationOrder, {
                    orderId,
                  })
                )
        );

      return { withOrder } satisfies IReservationOrderSections;
    })
  );

  static Live = this.Default.pipe(
    Layer.provide(WorkspaceDatabaseAdvisoryLock.Default)
  );
}

class SectionFailure<E> extends Data.TaggedError(
  "ReservationOrderSectionFailure"
)<{
  readonly error: E;
}> {}
