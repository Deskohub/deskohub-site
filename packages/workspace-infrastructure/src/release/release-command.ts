import * as BunServices from "@effect/platform-bun/BunServices";
import { Stage } from "alchemy/Stage";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import { Command, Flag } from "effect/cli";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  configuredWorkspaceStack,
  ImageDigest,
  type WorkspaceStackConfig,
} from "../config/stack-config";
import {
  standaloneAlchemyAuth,
  workspaceGcpAccess,
  workspaceGoogleApiAccess,
} from "../gcp-access";
import { verifyStackTarget } from "../stack-target";
import { alchemyServiceApply } from "./alchemy-service-apply";
import { cloudRunServiceReadbackLayer } from "./cloud-run-readback";
import {
  gcsReleaseRecordStoreLayer,
  releaseRecordLocation,
} from "./gcs-release-store";
import {
  deliverRelease,
  recoverRelease,
  restoreRelease,
} from "./release-delivery";
import { GitSha, ReleaseId } from "./release-record";
import { ReleaseRecordStore } from "./release-record-store";

/** The verified stack every release command acts on. */
export class ReleaseStack extends Context.Service<
  ReleaseStack,
  WorkspaceStackConfig
>()("@deskohub/workspace-infrastructure/ReleaseStack") {}

const printJson = (value: unknown) =>
  Console.log(JSON.stringify(value, null, 2));

const deliverCommand = Command.make(
  "deliver",
  {
    sha: Flag.String("sha").pipe(
      Flag.withDescription("Full commit SHA the image was built from")
    ),
    imageDigest: Flag.String("image-digest").pipe(
      Flag.withDescription("The image's sha256 digest in Artifact Registry")
    ),
  },
  ({ sha, imageDigest }) =>
    Effect.gen(function* () {
      const input = {
        sha: yield* Schema.decodeEffect(GitSha)(sha),
        imageDigest: yield* Schema.decodeEffect(ImageDigest)(imageDigest),
      };
      const config = yield* ReleaseStack;
      yield* printJson(yield* deliverRelease(config, input));
    })
).pipe(
  Command.withDescription(
    "Stage a digest-pinned build, verify its zero-traffic revision, promote and settle it"
  )
);

const restoreCommand = Command.make(
  "restore",
  {
    releaseId: Flag.String("release-id").pipe(
      Flag.withDescription("The previous or still-compatible release to serve")
    ),
    expectedGeneration: Flag.Int("expected-generation").pipe(
      Flag.withDescription(
        "The record generation `status` showed; a newer decision refuses the restore"
      )
    ),
  },
  ({ releaseId, expectedGeneration }) =>
    Effect.gen(function* () {
      const input = {
        releaseId: yield* Schema.decodeEffect(ReleaseId)(releaseId),
        expectedGeneration,
      };
      const config = yield* ReleaseStack;
      yield* printJson(yield* restoreRelease(config, input));
    })
).pipe(
  Command.withDescription(
    "Move traffic back to an earlier verified release and settle it"
  )
);

const recoverCommand = Command.make("recover", {}, () =>
  Effect.gen(function* () {
    const config = yield* ReleaseStack;
    yield* printJson(yield* recoverRelease(config));
  })
).pipe(
  Command.withDescription(
    "Re-apply and settle a traffic change an interrupted run left pending"
  )
);

const statusCommand = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const store = yield* ReleaseRecordStore;
    yield* printJson(yield* store.read);
  })
).pipe(
  Command.withDescription("Print the release record and its store version")
);

export const releaseCommand = Command.make("workspace-release").pipe(
  Command.withDescription(
    "Operate Workspace releases through the generation-fenced release record"
  ),
  Command.withSubcommands([
    deliverCommand,
    restoreCommand,
    recoverCommand,
    statusCommand,
  ])
);

/**
 * The live release runtime for the configured stack. It refuses to start
 * unless the effective GCP project is the config's project, so one stage's
 * credentials never touch another stage's record or services.
 */
export const liveReleaseRuntime = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* configuredWorkspaceStack;
    const verified = Layer.effectDiscard(
      verifyStackTarget(config).pipe(Effect.provideService(Stage, config.stage))
    ).pipe(Layer.provide(workspaceGcpAccess));
    const platform = Layer.mergeAll(
      gcsReleaseRecordStoreLayer(releaseRecordLocation(config)),
      cloudRunServiceReadbackLayer(config)
    ).pipe(Layer.provide(workspaceGoogleApiAccess));
    return Layer.mergeAll(
      Layer.succeed(ReleaseStack, config),
      platform,
      alchemyServiceApply(config).pipe(Layer.provide(BunServices.layer))
    ).pipe(Layer.provideMerge(verified), Layer.provide(standaloneAlchemyAuth));
  })
);
