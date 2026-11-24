import { Context, Effect, Layer, Predicate, Struct } from "effect";
import { providePerRequest } from "./provide-per-request";

/** A service whose every member is an operation that needs nothing more. */
type Operations<S> = {
  readonly [K in keyof S]: (...input: never) => Effect.Effect<unknown, unknown>;
};

/**
 * `service` with every operation run on its own instance of
 * `implementation`, built for that operation with `providePerRequest` over
 * what its run or request already built. `operations` names each of them.
 *
 * Use it for a service an HTTP API builds for the whole handler whose
 * implementation keeps state for its request, such as a release decision or
 * a consent cache: the handler lives for the process, so a plain
 * implementation would hand that state to every later request.
 *
 * `implementation` holds only that request state. What it requires, such as
 * provider clients and repositories, is built once with the returned Layer,
 * by whoever provides it, and every operation's instance takes that one.
 */
export const servicePerOperation = <I, S extends Operations<S>, RIn = never>(
  service: Context.Key<I, S>,
  operations: { readonly [K in keyof S]: true },
  implementation: Layer.Layer<I, never, RIn>
): Layer.Layer<I, never, RIn> =>
  Layer.effect(
    service,
    Effect.flatMap(Effect.context<RIn>(), (shared) => {
      const forward =
        (name: keyof S) =>
        (...input: ReadonlyArray<unknown>) =>
          Effect.flatMap(
            Effect.service(service),
            (instance): Effect.Effect<unknown, unknown> =>
              Reflect.apply(instance[name], instance, input)
          ).pipe(
            providePerRequest(implementation),
            // The operation's own context wins, so `shared` adds only the
            // requirements built with this Layer, never the span or request
            // context that build ran in.
            Effect.updateContext((operation: Context.Context<never>) =>
              Context.merge(shared, operation)
            )
          );
      const names = Struct.keys(operations);
      const forwarded = Object.fromEntries(
        names.map((name) => [name, forward(name)])
      );
      // Every operation `operations` names is forwarded, so `forwarded` is
      // the service; the check is what lets the types say so.
      const isService = (
        value: typeof forwarded
      ): value is typeof forwarded & S =>
        names.every((name) => Predicate.isFunction(value[name]));
      return isService(forwarded)
        ? Effect.succeed(forwarded)
        : Effect.die(
            new Error("An operation of the service is not forwarded.")
          );
    })
  );
