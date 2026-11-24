import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { findOrderKind } from "./order-kind";

test("reads a route value that is not an order ID as no order, without querying", async () => {
  // The mocked database dies on any query, so a lookup would fail the test.
  const kind = await findOrderKind("not-an-order-id").pipe(
    Effect.provide(Layer.mock(WorkspaceDatabase, {})),
    Effect.runPromise
  );

  expect(kind).toBeUndefined();
});
