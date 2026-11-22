import * as GCP from "@alchemy.run/gcp";
import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { decodeWorkspaceStackConfig } from "./src/config/stack-config";
import {
  emptyReleaseRecord,
  ReleaseRecord,
} from "./src/release/release-record";
import { declareWorkspaceStack } from "./src/workspace-stack";

/**
 * The Workspace stack. CI supplies the stage config and the release record
 * it read from the release store; `GOOGLE_PROJECT_ID` must name the same
 * project as the config, so credentials for one stage never apply another.
 */
export default Alchemy.Stack(
  "DeskohubWorkspace",
  {
    providers: GCP.providers(),
    state: Layer.unwrap(
      Config.String("WORKSPACE_STATE_BUCKET").pipe(
        Effect.map((bucketName) => GCP.state({ bucketName }))
      )
    ).pipe(Layer.orDie),
  },
  Effect.gen(function* () {
    const rawConfig = yield* Config.String("WORKSPACE_STACK_CONFIG");
    const config = yield* Schema.decodeEffect(
      Schema.fromJsonString(Schema.Unknown)
    )(rawConfig).pipe(Effect.flatMap(decodeWorkspaceStackConfig), Effect.orDie);
    const ambientProject = yield* Config.String("GOOGLE_PROJECT_ID");
    if (ambientProject !== config.projectId) {
      return yield* Effect.die(
        new Error(
          `GOOGLE_PROJECT_ID does not match the ${config.stage} stack project.`
        )
      );
    }
    const rawRecord = yield* Config.option(
      Config.String("WORKSPACE_RELEASE_RECORD")
    );
    const record =
      rawRecord._tag === "None"
        ? emptyReleaseRecord
        : yield* Schema.decodeEffect(Schema.fromJsonString(ReleaseRecord))(
            rawRecord.value
          ).pipe(Effect.orDie);
    return yield* declareWorkspaceStack(config, record, yield* DateTime.now);
  })
);
