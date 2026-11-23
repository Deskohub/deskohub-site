import * as GCP from "@alchemy.run/gcp";
import * as Alchemy from "alchemy";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { decodeWorkspaceStackConfig } from "./src/config/stack-config";
import { verifyStackTarget } from "./src/stack-target";
import { declareWorkspaceFoundation } from "./src/workspace-stack";

/** The stage config CI supplies; it alone selects project, stage and state. */
const stackConfig = Config.String("WORKSPACE_STACK_CONFIG").pipe(
  Effect.flatMap((raw) =>
    Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(raw)
  ),
  Effect.flatMap(decodeWorkspaceStackConfig),
  Effect.orDie
);

/**
 * The Workspace foundation stack. State lives in the config's own state
 * bucket, reached only after `verifyStackTarget`, so credentials or state
 * of one stage never apply another.
 *
 * The release-owned Cloud Run services (`declareWorkspaceServices`) are not
 * declared here: they need the authoritative release record read under its
 * generation fence from the durable release store, which ships with the
 * hosted #1452 proof. A CI snapshot is never trusted in its place.
 */
export default Alchemy.Stack(
  "DeskohubWorkspace",
  {
    providers: GCP.providers(),
    state: Layer.unwrap(
      stackConfig.pipe(
        Effect.map((config) =>
          Layer.mergeAll(
            GCP.state({ bucketName: config.stateBucket }),
            Layer.effectDiscard(verifyStackTarget(config)).pipe(
              // The same resolution the GCS state store uses.
              Layer.provide(
                GCP.fromCredentials().pipe(
                  Layer.provideMerge(GCP.fromAuthProvider()),
                  Layer.provideMerge(GCP.GcpAuth),
                  Layer.provideMerge(CredentialsStoreLive)
                )
              ),
              Layer.orDie
            )
          )
        )
      )
    ),
  },
  Effect.gen(function* () {
    const config = yield* stackConfig;
    return yield* declareWorkspaceFoundation(config);
  })
);
