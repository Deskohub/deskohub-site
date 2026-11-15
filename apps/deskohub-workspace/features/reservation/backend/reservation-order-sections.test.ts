import { describe, expect, test } from "bun:test";
import { Effect, type Layer } from "effect";
import { SqlError } from "effect/unstable/sql";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import {
  HeldReservationOrder,
  ReservationOrderSections,
  ReservationOrderSectionUnavailableError,
} from "./reservation-order-sections";
import { makeReservationOrderSections } from "./reservation-order-sections.test-utils";

const orderId = workspaceReservationIdSchema.make(
  "0f4c2a7e-5b1d-4c3a-9e8f-1a2b3c4d5e60"
);

const runSections = <A, E>(
  layer: Layer.Layer<ReservationOrderSections>,
  use: (
    sections: ReservationOrderSections["Service"]
  ) => Effect.Effect<A, E, never>
) =>
  ReservationOrderSections.pipe(
    Effect.flatMap(use),
    Effect.provide(layer),
    Effect.result,
    Effect.runPromise
  );

const recordHeldOrder = (events: string[]) =>
  HeldReservationOrder.pipe(
    Effect.map((held) => {
      events.push(`work:${held.orderId}`);
      return held.orderId;
    })
  );

describe("ReservationOrderSections.withOrder", () => {
  test("runs the work holding the order's lock with the held order provided", async () => {
    const { layer, events } = makeReservationOrderSections();

    const result = await runSections(layer, (sections) =>
      sections.withOrder(orderId, recordHeldOrder(events))
    );

    expect(result).toMatchObject({ _tag: "Success", success: orderId });
    expect(events).toEqual([
      `order-lock-acquired:${orderId}`,
      `work:${orderId}`,
      `order-lock-released:${orderId}`,
    ]);
  });

  test("reuses an enclosing hold of the same order without a second lock", async () => {
    const { layer, events } = makeReservationOrderSections();

    const result = await runSections(layer, (sections) =>
      sections.withOrder(
        orderId,
        sections.withOrder(orderId, recordHeldOrder(events))
      )
    );

    expect(result).toMatchObject({ _tag: "Success", success: orderId });
    expect(events).toEqual([
      `order-lock-acquired:${orderId}`,
      `work:${orderId}`,
      `order-lock-released:${orderId}`,
    ]);
  });

  test("fails with the order section unavailable when the lock cannot be taken", async () => {
    const { layer, events } = makeReservationOrderSections({
      lockUnavailable: true,
    });

    const result = await runSections(layer, (sections) =>
      sections.withOrder(orderId, recordHeldOrder(events))
    );

    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") return;
    expect(result.failure).toBeInstanceOf(
      ReservationOrderSectionUnavailableError
    );
    expect(result.failure).toMatchObject({ orderId });
    expect(events).toEqual([]);
  });

  test("passes the work's own SqlError through unchanged", async () => {
    const { layer, events } = makeReservationOrderSections();
    const workFailure = new SqlError.SqlError({
      reason: new SqlError.UnknownError({
        cause: new Error("statement failed"),
        message: "statement failed",
        operation: "execute",
      }),
    });

    const result = await runSections(layer, (sections) =>
      sections.withOrder(orderId, Effect.fail(workFailure))
    );

    expect(result).toMatchObject({ _tag: "Failure", failure: workFailure });
    expect(events).toEqual([
      `order-lock-acquired:${orderId}`,
      `order-lock-released:${orderId}`,
    ]);
  });
});
