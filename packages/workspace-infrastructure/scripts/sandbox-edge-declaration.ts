import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { runCommandLine } from "../src/command-line";
import {
  configuredWorkspaceStack,
  type WorkspaceStackConfig,
} from "../src/config/stack-config";
import {
  edgeObjectNames,
  tokenRouteExclusionFilter,
} from "../src/resources/edge-declarations";

/**
 * What the configured stack declares for its edge: the protocol, every
 * physical object name and the token-route exclusion filter. The live
 * state holds no stack outputs object, so the hosted proof reads the
 * live edge by these names and compares it with this declaration. `null`
 * when the stack declares no edge.
 */
export const declaredEdge = (config: WorkspaceStackConfig) =>
  config.edge === undefined
    ? null
    : {
        protocol: config.edge.enableHttps ? "https" : "http",
        names: edgeObjectNames(config),
        tokenRouteExclusionFilter,
      };

if (import.meta.main) {
  runCommandLine(
    configuredWorkspaceStack.pipe(
      Effect.flatMap((config) =>
        Console.log(JSON.stringify(declaredEdge(config)))
      )
    )
  );
}
