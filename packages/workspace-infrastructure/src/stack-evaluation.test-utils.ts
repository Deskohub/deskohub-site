import { Credentials, Providers } from "@alchemy.run/gcp";
import type { ResourceLike } from "alchemy/Resource";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import { EdgeBackendServiceProvider } from "./resources/edge-backend-service";
import { EdgeSecurityPolicyProvider } from "./resources/edge-security-policy";

/**
 * The providers a declaration names. Registration only looks them up on
 * deploy, so the GCP collection is empty and the edge providers' token
 * lookup and requests die if anything calls them.
 */
const evaluationProviders = Layer.mergeAll(
  Layer.succeed(Providers, {
    kind: "ProviderCollection",
    get: () => undefined,
    providers: {},
  }),
  EdgeBackendServiceProvider,
  EdgeSecurityPolicyProvider
).pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(
        Credentials,
        Effect.die(new Error("evaluation looked a token up"))
      ),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() =>
          Effect.die(new Error("evaluation sent a request"))
        )
      ),
      Layer.succeed(Stage, "sandbox")
    )
  )
);

/**
 * Evaluate a declaration against an empty in-memory stack. Registration
 * runs the real beta.87 constructors (and their logical-ID checks) without
 * providers, state or credentials.
 */
export const evaluate = async <A, E>(
  declaration: Effect.Effect<
    A,
    E,
    Stack | Layer.Success<typeof evaluationProviders>
  >
) => {
  const resources: Record<string, ResourceLike> = {};
  const registration = declaration.pipe(
    Effect.provide(evaluationProviders),
    Effect.provideService(Stack, {
      name: "DeskohubWorkspaceTest",
      stage: "sandbox",
      resources,
      bindings: {},
      actions: {},
    })
  );
  const exit = await Effect.runPromiseExit(registration);
  return { exit, resources };
};
