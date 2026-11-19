import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Effect, Layer } from "effect";
import { paymentProviderFallbacks } from "@/db/schema/payment-provider-fallbacks";
import { createWorkspacePostgresSuiteDatabase } from "@/shared/testing/workspace-postgres-test-database.test-utils";
import { PaymentProviderFallbackRepository } from "./payment-provider-fallback.repository";

const database = await createWorkspacePostgresSuiteDatabase(
  "payment_provider_fallback"
);

describe.skipIf(!database)("Payment provider fallback on Postgres", () => {
  if (!database) return;

  afterAll(() => database.close());

  const layer = PaymentProviderFallbackRepository.Default.pipe(
    Layer.provide(database.layer)
  );
  const run = <A, E>(
    effect: Effect.Effect<A, E, PaymentProviderFallbackRepository>
  ) => Effect.runPromise(effect.pipe(Effect.provide(layer)));

  test("activates and resets each deployment independently by hostname digest", async () => {
    const repository = await run(PaymentProviderFallbackRepository);
    const firstHost = "first-build.example.test";
    const firstHostAlias = `${firstHost.toUpperCase()}.`;
    const secondHost = "second-build.example.test";

    expect(await run(repository.isActive(firstHost))).toBe(false);
    await Promise.all([
      run(repository.activate(firstHost)),
      run(repository.activate(firstHostAlias)),
    ]);

    expect(
      await run(database.db.select().from(paymentProviderFallbacks))
    ).toEqual([
      {
        deploymentHostHash: createHash("sha256")
          .update(firstHost)
          .digest("hex"),
      },
    ]);
    expect(await run(repository.isActive(firstHostAlias))).toBe(true);
    expect(await run(repository.isActive(secondHost))).toBe(false);

    await run(repository.activate(secondHost));
    await run(repository.reset(firstHostAlias));
    await run(repository.reset(firstHost));

    expect(await run(repository.isActive(firstHost))).toBe(false);
    expect(await run(repository.isActive(secondHost))).toBe(true);
  });

  test("rejects malformed deployment hosts with a redacted error", async () => {
    const repository = await run(PaymentProviderFallbackRepository);
    const invalidHost = "https://build.example.test";
    const invalidHostError = {
      _tag: "InvalidPaymentProviderFallbackHost",
      message: "Expected a deployment hostname.",
    };

    for (const input of [
      invalidHost,
      "build.example.test:443",
      "build.example.test/path",
      "build.example.test..",
      "build.example.test\n",
      "-build.example.test",
      "build..example.test",
      "127.0.0.1",
      `${"a".repeat(64)}.example.test`,
    ]) {
      expect(await run(Effect.flip(repository.isActive(input)))).toEqual(
        expect.objectContaining(invalidHostError)
      );
    }

    for (const operation of [repository.activate, repository.reset]) {
      expect(await run(Effect.flip(operation(invalidHost)))).toEqual(
        expect.objectContaining(invalidHostError)
      );
    }
  });
});
