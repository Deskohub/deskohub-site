import { Effect, Layer } from "effect";
import { HttpApi, HttpApiBuilder, type HttpApiGroup } from "effect/http-api";

/**
 * Handlers for every group of `api` except `handled`, each failing with a
 * defect if called, so a test can serve an API's real handlers for a few
 * groups through `HttpRouter.toWebHandler`.
 */
export const unhandledHttpApiGroups = <
  ApiId extends string,
  Groups extends HttpApiGroup.Constraint,
>(
  api: HttpApi.HttpApi<ApiId, Groups>,
  handled: ReadonlyArray<string>
) => {
  const groups: Array<HttpApiGroup.Top> = [];
  HttpApi.reflect(api, {
    onGroup: ({ group }) => {
      groups.push(group);
    },
    onEndpoint: () => undefined,
  });
  return Layer.mergeAll(
    Layer.empty,
    ...groups
      .filter(({ identifier }) => !handled.includes(identifier))
      .map(unhandledGroup)
  );
};

// A group's service key derives from its identifier alone, so a one-group API
// registers the service `HttpApiBuilder.layer(api)` looks up for that group.
const unhandledGroup = (group: HttpApiGroup.Top) =>
  HttpApiBuilder.group(
    HttpApi.make(group.identifier).add(group),
    group.identifier,
    (handlers) =>
      handlers.handleAll(
        Object.fromEntries(
          Object.keys(group.endpoints).map((endpoint) => [
            endpoint,
            () =>
              Effect.die(
                new Error(`Unhandled endpoint: ${group.identifier}.${endpoint}`)
              ),
          ])
        )
      )
  );
