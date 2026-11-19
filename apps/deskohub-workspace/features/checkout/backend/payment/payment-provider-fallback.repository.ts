import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Context, Data, Effect, Layer } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { paymentProviderFallbacks } from "@/db/schema/payment-provider-fallbacks";

class InvalidPaymentProviderFallbackHost extends Data.TaggedError(
  "InvalidPaymentProviderFallbackHost"
)<{ readonly message: string }> {}

type PaymentProviderFallbackFailure =
  | EffectDrizzleQueryError
  | InvalidPaymentProviderFallbackHost;

// Callers supply the immutable hostname of the deployment, such as VERCEL_URL.
interface IPaymentProviderFallbackRepository {
  readonly isActive: (
    deploymentHost: string
  ) => Effect.Effect<boolean, PaymentProviderFallbackFailure>;
  readonly activate: (
    deploymentHost: string
  ) => Effect.Effect<void, PaymentProviderFallbackFailure>;
  readonly reset: (
    deploymentHost: string
  ) => Effect.Effect<void, PaymentProviderFallbackFailure>;
}

export class PaymentProviderFallbackRepository extends Context.Service<
  PaymentProviderFallbackRepository,
  IPaymentProviderFallbackRepository
>()("PaymentProviderFallbackRepository") {
  static Default = Layer.effect(
    this,
    Effect.gen(function* () {
      const { db } = yield* WorkspaceDatabase;

      const isActive = Effect.fn("PaymentProviderFallbackRepository.isActive")(
        function* (deploymentHost: string) {
          const hash = yield* hashDeploymentHost(deploymentHost);
          const [row] = yield* db
            .select({ hash: paymentProviderFallbacks.deploymentHostHash })
            .from(paymentProviderFallbacks)
            .where(eq(paymentProviderFallbacks.deploymentHostHash, hash))
            .limit(1);
          return row !== undefined;
        }
      );

      const activate = Effect.fn("PaymentProviderFallbackRepository.activate")(
        function* (deploymentHost: string) {
          const hash = yield* hashDeploymentHost(deploymentHost);
          yield* db
            .insert(paymentProviderFallbacks)
            .values({ deploymentHostHash: hash })
            .onConflictDoNothing({
              target: paymentProviderFallbacks.deploymentHostHash,
            });
        }
      );

      const reset = Effect.fn("PaymentProviderFallbackRepository.reset")(
        function* (deploymentHost: string) {
          const hash = yield* hashDeploymentHost(deploymentHost);
          yield* db
            .delete(paymentProviderFallbacks)
            .where(eq(paymentProviderFallbacks.deploymentHostHash, hash));
        }
      );

      return { isActive, activate, reset };
    })
  );
}

const deploymentHostnamePattern =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

const hashDeploymentHost = Effect.fnUntraced(function* (
  deploymentHost: string
) {
  const host = deploymentHost.replace(/\.$/, "");
  if (host.length > 253 || !deploymentHostnamePattern.test(host)) {
    return yield* new InvalidPaymentProviderFallbackHost({
      message: "Expected a deployment hostname.",
    });
  }

  return createHash("sha256").update(host.toLowerCase()).digest("hex");
});
