import { Effect, Layer } from "effect";
import { SqlError } from "effect/unstable/sql";
import { WorkspaceDatabaseAdvisoryLock } from "@/db/postgres-advisory-lock";
import { ReservationOrderSections } from "./reservation-order-sections";

export type ReservationOrderSectionsFixture = {
  /** Fails taking the lock with the advisory lock's SqlError. */
  readonly lockUnavailable?: boolean;
  /** Records into the caller's events, to interleave the lock with its own. */
  readonly events?: string[];
};

/**
 * The real `ReservationOrderSections` over an in-memory advisory lock, so
 * unit tests exercise the real proof, reuse, and error mapping and can see
 * where the order lock is held. `events` records
 * `order-lock-acquired:<orderId>` and `order-lock-released:<orderId>`;
 * callers may push their own events into it to place work inside or outside
 * the lock.
 */
export const makeReservationOrderSections = (
  fixture: ReservationOrderSectionsFixture = {}
): {
  readonly layer: Layer.Layer<ReservationOrderSections>;
  readonly events: string[];
} => {
  const events = fixture.events ?? [];
  const record = (event: string) =>
    Effect.sync(() => {
      events.push(event);
    });

  const holdLock = <A, E, R>(
    key: readonly [string, string],
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<A, E | SqlError.SqlError, R> =>
    fixture.lockUnavailable === true
      ? Effect.fail(
          new SqlError.SqlError({
            reason: new SqlError.ConnectionError({
              cause: new Error("advisory lock unavailable"),
              message: "advisory lock unavailable",
              operation: "connect",
            }),
          })
        )
      : Effect.acquireUseRelease(
          record(`order-lock-acquired:${key[1]}`),
          () => effect,
          () => record(`order-lock-released:${key[1]}`)
        );

  return {
    events,
    layer: ReservationOrderSections.Default.pipe(
      Layer.provide(
        Layer.succeed(WorkspaceDatabaseAdvisoryLock, {
          withTransactionPermit: (effect) => effect,
          withLock: holdLock,
          withLocks: (_keys, effect) =>
            Effect.die("Order sections take one lock at a time.").pipe(
              Effect.andThen(effect)
            ),
        })
      )
    ),
  };
};
