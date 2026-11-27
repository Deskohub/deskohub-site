import "server-only";

import {
  backendRevisionHeader,
  PreviewRuntimeBinding,
  previewBackendBranchTag,
  previewDatabaseEndpoint,
  previewGenerationHeader,
  previewRuntimeGeneration,
  taggedCloudRunOrigin,
} from "@deskohub/workspace-cloud-run/preview-generation";
import { Config, Data, Effect, Redacted, Schema } from "effect";
import { selectDeploymentStageSetting } from "@/shared/deployment/deployment-stage-setting";

export class PreviewBackendUnavailable extends Data.TaggedError(
  "PreviewBackendUnavailable"
) {}

const emailPreferencesTransportSetting = Config.schema(
  Schema.Literals(["local", "rpc"]),
  "WORKSPACE_EMAIL_PREFERENCES_TRANSPORT"
).pipe(Config.withDefault("local"));

const runtimeSettings = Config.all({
  VERCEL_ENV: Config.String("VERCEL_ENV").pipe(Config.withDefault("")),
  WORKSPACE_DEPLOYMENT_STAGE: Config.String("WORKSPACE_DEPLOYMENT_STAGE").pipe(
    Config.withDefault("")
  ),
  host: Config.String("WORKSPACE_RUNTIME_HOST").pipe(
    Config.withDefault("vercel")
  ),
});

export const emailPreferencesTransport = Effect.gen(function* () {
  const transport = yield* emailPreferencesTransportSetting;
  if (transport === "local") {
    return transport;
  }
  const settings = yield* runtimeSettings;
  const stage = selectDeploymentStageSetting(settings);
  if (settings.VERCEL_ENV === "preview") {
    return stage === "preview" && settings.host === "vercel"
      ? "preview-rpc"
      : "unclassified-rpc";
  }
  if (
    (stage === "development" || stage === "production") &&
    (settings.host === "container" || settings.VERCEL_ENV === stage)
  ) {
    return "rpc";
  }
  return "unclassified-rpc";
});

const previewBindingConfig = Config.all({
  commitSha: Config.String("VERCEL_GIT_COMMIT_SHA"),
  deploymentId: Config.String("VERCEL_DEPLOYMENT_ID"),
  branch: Config.schema(
    Schema.String.check(Schema.isMinLength(1)),
    "VERCEL_GIT_COMMIT_REF"
  ),
  databaseUrl: Config.Redacted("DATABASE_URL"),
});

export const workspacePreviewBinding = Effect.gen(function* () {
  const { commitSha, deploymentId, branch, databaseUrl } =
    yield* previewBindingConfig;
  const databaseEndpoint = previewDatabaseEndpoint(Redacted.value(databaseUrl));
  if (databaseEndpoint === undefined) {
    return yield* new PreviewBackendUnavailable();
  }
  const binding = yield* Schema.decodeEffect(PreviewRuntimeBinding)({
    commitSha,
    deploymentId,
    branchTag: previewBackendBranchTag(branch),
    databaseEndpoint,
  });
  return {
    commitSha: binding.commitSha,
    branchTag: binding.branchTag,
    generation: previewRuntimeGeneration(binding),
  };
}).pipe(Effect.mapError(() => new PreviewBackendUnavailable()));

export type WorkspacePreviewBinding = Effect.Success<
  typeof workspacePreviewBinding
>;

export const emailPreferencesBackend = Effect.gen(function* () {
  const transport = yield* emailPreferencesTransport;
  if (transport === "unclassified-rpc") {
    return yield* new PreviewBackendUnavailable();
  }
  const preview =
    transport === "preview-rpc" ? yield* workspacePreviewBinding : undefined;
  return { transport, preview };
});

export const previewBackendTarget = (
  audience: string,
  preview: WorkspacePreviewBinding
) => {
  const url = taggedCloudRunOrigin(audience, preview.branchTag);
  if (url === undefined) {
    return Effect.fail(new PreviewBackendUnavailable());
  }
  const requestHeaders = { [previewGenerationHeader]: preview.generation };
  return Effect.succeed({
    url,
    requestHeaders,
    expectedResponseHeaders: {
      ...requestHeaders,
      [backendRevisionHeader]: preview.commitSha,
    },
  });
};

export const withPreviewBackendDeadline = <A, E, R>(
  effect: Effect.Effect<A, E, R>
) =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () => Effect.fail(new PreviewBackendUnavailable()),
    })
  );
