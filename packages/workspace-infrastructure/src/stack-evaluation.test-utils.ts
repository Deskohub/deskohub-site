import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";

export type RegisteredResource = {
  readonly Type: string;
  // biome-ignore lint/suspicious/noExplicitAny: Alchemy registers raw input props.
  readonly Props: any;
};

/**
 * Evaluate a declaration against an empty in-memory stack. Registration
 * runs the real beta.87 constructors (and their logical-ID checks) without
 * providers, state or credentials.
 */
export const evaluate = async <A, E, R>(
  declaration: Effect.Effect<A, E, R>
) => {
  const resources: Record<string, RegisteredResource> = {};
  const registration = declaration.pipe(
    Effect.provideService(Stack, {
      name: "DeskohubWorkspaceTest",
      stage: "sandbox",
      resources,
      bindings: {},
      actions: {},
    } as never)
  ) as Effect.Effect<A, E>; // Providers are only used on deploy, never here.
  const exit = await Effect.runPromiseExit(registration);
  return { exit, resources };
};
