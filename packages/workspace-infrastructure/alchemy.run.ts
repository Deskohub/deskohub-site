import * as GCP from "@alchemy.run/gcp";
import * as Alchemy from "alchemy";
import { Stage } from "alchemy/Stage";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { decodeWorkspaceStackConfig } from "./src/config/stack-config";
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
 * bucket, and the Alchemy stage and `GOOGLE_PROJECT_ID` must both name the
 * config's stage and project, so credentials or state of one stage never
 * apply another.
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
        Effect.map((config) => GCP.state({ bucketName: config.stateBucket }))
      )
    ),
  },
  Effect.gen(function* () {
    const config = yield* stackConfig;
    const stage = yield* Stage;
    const ambientProject = yield* Config.String("GOOGLE_PROJECT_ID");
    if (stage !== config.stage || ambientProject !== config.projectId) {
      return yield* Effect.die(
        new Error(
          `The Alchemy stage and GOOGLE_PROJECT_ID must match the ${config.stage} stack configuration.`
        )
      );
    }
    return yield* declareWorkspaceFoundation(config);
  })
);
