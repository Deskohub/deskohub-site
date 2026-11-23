import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

/** The default region for every Workspace stack (#1452). */
export const defaultWorkspaceRegion = "europe-west1";

export const WorkspaceStage = Schema.Literals([
  "sandbox",
  "preview",
  "production",
]).annotate({
  identifier: "WorkspaceStage",
  description: "The isolated Google Cloud environment a stack deploys to.",
});
export type WorkspaceStage = typeof WorkspaceStage.Type;

export const GcpProjectId = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/)
).pipe(
  Schema.brand("GcpProjectId"),
  Schema.annotate({
    identifier: "GcpProjectId",
    description: "A Google Cloud project ID; each stage has its own project.",
  })
);
export type GcpProjectId = typeof GcpProjectId.Type;

export const GcpRegion = Schema.String.check(
  Schema.isPattern(/^[a-z]+-[a-z]+[0-9]$/)
).pipe(
  Schema.brand("GcpRegion"),
  Schema.annotate({
    identifier: "GcpRegion",
    description: "A Google Cloud region such as europe-west1.",
  })
);
export type GcpRegion = typeof GcpRegion.Type;

export const GcsBucketName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9_-]{1,61}[a-z0-9]$/)
).pipe(
  Schema.brand("GcsBucketName"),
  Schema.annotate({
    identifier: "GcsBucketName",
    description: "A Cloud Storage bucket name without dots.",
  })
);
export type GcsBucketName = typeof GcsBucketName.Type;

export const ServiceAccountEmail = Schema.String.check(
  Schema.isPattern(
    /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/
  )
).pipe(
  Schema.brand("ServiceAccountEmail"),
  Schema.annotate({
    identifier: "ServiceAccountEmail",
    description: "A user-managed service account in a Workspace project.",
  })
);
export type ServiceAccountEmail = typeof ServiceAccountEmail.Type;

/**
 * A Secret Manager reference. It names a secret and pins one numeric
 * version; the value itself never enters configuration or Alchemy state.
 */
export const WorkspaceWorkload = Schema.Literals([
  "web",
  "tasks-worker",
  "scheduler-worker",
]).annotate({
  identifier: "WorkspaceWorkload",
  description: "One of the three Cloud Run services built from the image.",
});
export type WorkspaceWorkload = typeof WorkspaceWorkload.Type;

export const SecretReference = Schema.Struct({
  /** The workloads that receive the secret; each gets its own grant. */
  consumers: Schema.Array(WorkspaceWorkload).check(Schema.isMinLength(1)),
  environmentVariable: Schema.String.check(
    Schema.isPattern(/^[A-Z][A-Z0-9_]*$/)
  ),
  secretId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,255}$/)),
  version: Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/)),
}).annotate({
  identifier: "SecretReference",
  description:
    "A Secret Manager secret ID and pinned version, never a secret value.",
});
export type SecretReference = typeof SecretReference.Type;

export const WorkspaceServiceAccounts = Schema.Struct({
  /** The GitHub Actions identity that applies the stack. */
  deployer: ServiceAccountEmail,
  /** Runtime identity of the public web service. */
  webRuntime: ServiceAccountEmail,
  /** Runtime identity of the private Cloud Tasks worker. */
  tasksWorkerRuntime: ServiceAccountEmail,
  /** Runtime identity of the private Cloud Scheduler worker. */
  schedulerWorkerRuntime: ServiceAccountEmail,
  /** OIDC identity Cloud Tasks presents to the tasks worker. */
  tasksInvoker: ServiceAccountEmail,
  /** OIDC identity Cloud Scheduler presents to the scheduler worker. */
  schedulerInvoker: ServiceAccountEmail,
  /** Uploads mobile update assets; may create objects but never replace them. */
  mobileUpdatesPublisher: ServiceAccountEmail,
}).annotate({ identifier: "WorkspaceServiceAccounts" });
export type WorkspaceServiceAccounts = typeof WorkspaceServiceAccounts.Type;

const positiveInt = (maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum }));

export const WorkspaceCapacity = Schema.Struct({
  webMaxInstances: positiveInt(100),
  workerMaxInstances: positiveInt(100),
  queueMaxConcurrentDispatches: positiveInt(1000),
  queueMaxDispatchesPerSecond: positiveInt(500),
}).annotate({ identifier: "WorkspaceCapacity" });
export type WorkspaceCapacity = typeof WorkspaceCapacity.Type;

/** An image reference pinned by digest. Tags are rejected. */
export const ImageDigest = Schema.String.check(
  Schema.isPattern(/^sha256:[a-f0-9]{64}$/)
).pipe(
  Schema.brand("ImageDigest"),
  Schema.annotate({
    identifier: "ImageDigest",
    description: "An immutable OCI image digest (sha256).",
  })
);
export type ImageDigest = typeof ImageDigest.Type;

const IsoDate = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
);

/** Approved spend and lifetime for a disposable sandbox (#1452). */
export const SandboxBudget = Schema.Struct({
  currency: Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/)),
  maximumSpend: Schema.Finite.check(Schema.isGreaterThan(0)),
  teardownAt: IsoDate,
}).annotate({ identifier: "SandboxBudget" });
export type SandboxBudget = typeof SandboxBudget.Type;

export const GcpProjectNumber = Schema.String.check(
  Schema.isPattern(/^[1-9][0-9]{5,19}$/)
).pipe(
  Schema.brand("GcpProjectNumber"),
  Schema.annotate({
    identifier: "GcpProjectNumber",
    description:
      "The numeric project number; it fixes deterministic run.app URLs.",
  })
);
export type GcpProjectNumber = typeof GcpProjectNumber.Type;

/**
 * A host the edge's URL map routes: a lowercase DNS hostname, or a
 * `*.`-prefixed wildcard, which only an edge without its managed
 * certificate may route.
 */
export const EdgeHost = Schema.String.check(
  Schema.isPattern(
    /^(?=.{1,253}$)(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
  )
).annotate({
  identifier: "EdgeHost",
  description:
    "A lowercase hostname such as workspace.example.com, or *.example.com.",
});

const isWildcardHost = (host: string) => host.startsWith("*.");

/**
 * The only project whose sandbox edge may serve plain HTTP, for a hosted
 * proof without DNS.
 */
export const plainHttpEdgeProject = "deskohub-workspace-sandbox";

/**
 * The stage's external load balancer, Cloud Armor and token-route log
 * exclusion. The static asset paths are fixed by the declaration, never by
 * configuration, so no other route can reach Cloud CDN.
 */
export const WorkspaceEdgeConfig = Schema.Struct({
  /**
   * Hostnames of the managed certificate and the URL map. Empty only
   * while HTTPS is off, when any host matches.
   */
  domains: Schema.Array(EdgeHost),
  /**
   * HTTPS with a managed certificate and a port 80 redirect. Only the
   * sandbox stage in `plainHttpEdgeProject` may turn it off.
   */
  enableHttps: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(true))
  ),
  /** Cloud CDN on the immutable static asset paths only. */
  staticCdnEnabled: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false))
  ),
  /** Preconfigured WAF rules only log until their matches are reviewed. */
  wafPreview: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(true))
  ),
  /** Requests per minute per client IP to `/api/auth/` before throttling. */
  authRateLimitPerMinute: Schema.Int.check(Schema.isGreaterThan(0)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(120))
  ),
}).annotate({ identifier: "WorkspaceEdgeConfig" });
export type WorkspaceEdgeConfig = typeof WorkspaceEdgeConfig.Type;

const BaseStackConfig = Schema.Struct({
  projectId: GcpProjectId,
  projectNumber: GcpProjectNumber,
  region: GcpRegion.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(defaultWorkspaceRegion))
  ),
  stateBucket: GcsBucketName,
  mobileUpdatesBucket: GcsBucketName,
  serviceAccounts: WorkspaceServiceAccounts,
  secrets: Schema.Array(SecretReference),
  capacity: WorkspaceCapacity,
  /** Cloud Scheduler jobs stay paused unless the environment is authorized. */
  schedulesEnabled: Schema.Boolean,
  /** Cloud Monitoring notification channel resource names. */
  alertNotificationChannels: Schema.Array(
    Schema.String.check(
      Schema.isPattern(/^projects\/[a-z0-9-]+\/notificationChannels\/[0-9]+$/)
    )
  ),
  /**
   * The digest of the OpenTelemetry collector sidecar image in the stage's
   * Workspace repository. When set, every Workspace service runs the
   * collector beside the app; when absent, services run the app alone.
   */
  telemetryCollectorImage: Schema.optionalKey(ImageDigest),
  /**
   * The stage's edge. Absent, the stack declares none; once a stack has
   * declared it, removing the key destroys it.
   */
  edge: Schema.optionalKey(WorkspaceEdgeConfig),
});

/**
 * A disposable run's suffix for Cloud Tasks queue IDs. Cloud Tasks keeps a
 * deleted queue's ID unavailable for days, so a sandbox proof that tears
 * down and reruns needs IDs of its own.
 */
export const DisposableQueueSuffix = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/)
);

export const SandboxStackConfig = Schema.Struct({
  ...BaseStackConfig.fields,
  stage: Schema.Literal("sandbox"),
  budget: SandboxBudget,
  disposableQueueSuffix: Schema.optionalKey(DisposableQueueSuffix),
}).annotate({ identifier: "SandboxStackConfig" });

export const PreviewStackConfig = Schema.Struct({
  ...BaseStackConfig.fields,
  stage: Schema.Literal("preview"),
}).annotate({ identifier: "PreviewStackConfig" });

export const ProductionStackConfig = Schema.Struct({
  ...BaseStackConfig.fields,
  stage: Schema.Literal("production"),
}).annotate({ identifier: "ProductionStackConfig" });

export const WorkspaceStackConfig = Schema.Union([
  SandboxStackConfig,
  PreviewStackConfig,
  ProductionStackConfig,
]).annotate({ identifier: "WorkspaceStackConfig" });
export type WorkspaceStackConfig = typeof WorkspaceStackConfig.Type;
export type WorkspaceStackConfigInput = typeof WorkspaceStackConfig.Encoded;

/**
 * A rejected stack configuration. It carries only the paths that failed,
 * never the rejected input, so logging it cannot leak a pasted secret.
 */
export class WorkspaceStackConfigInvalid extends Data.TaggedError(
  "WorkspaceStackConfigInvalid"
)<{
  readonly paths: ReadonlyArray<string>;
  readonly reason: "schema" | "secret-material" | "identity" | "edge";
}> {
  override get message() {
    return `Workspace stack configuration is invalid (${this.reason}) at: ${this.paths.join(", ")}`;
  }
}

/**
 * Shapes that only appear in secret material. A value that matches is
 * rejected even under an allowed key.
 */
const secretMaterialPatterns: ReadonlyArray<RegExp> = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /"private_key"\s*:/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
  /\bAIza[0-9A-Za-z_-]{20,}/,
  /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{8,}/,
  /\bgh[pousr]_[0-9A-Za-z]{20,}/,
  /\bya29\.[0-9A-Za-z_-]{10,}/,
];

const secretKeyPattern =
  /^(?:value|secretValue|password|token|apiKey|privateKey|credentials?|connectionString)$/i;

const findSecretMaterial = (
  input: unknown,
  path: ReadonlyArray<string> = []
): ReadonlyArray<string> => {
  if (typeof input === "string") {
    return secretMaterialPatterns.some((pattern) => pattern.test(input))
      ? [path.join(".") || "<root>"]
      : [];
  }
  if (Array.isArray(input)) {
    return input.flatMap((item, index) =>
      findSecretMaterial(item, [...path, String(index)])
    );
  }
  if (typeof input === "object" && input !== null) {
    return Object.entries(input).flatMap(([key, value]) =>
      secretKeyPattern.test(key)
        ? [[...path, key].join(".")]
        : findSecretMaterial(value, [...path, key])
    );
  }
  return [];
};

const issuePaths = (issue: SchemaIssue.Issue): ReadonlyArray<string> => [
  ...new Set(
    SchemaIssue.makeFormatterStandardSchemaV1()(issue).issues.map(
      (entry) => entry.path?.map(String).join(".") || "<root>"
    )
  ),
];

/**
 * The one state bucket of a project. The release record and its writer
 * lock live in it, so a config naming any other bucket would give the same
 * project and stage a second lock.
 */
export const workspaceStateBucket = (projectId: GcpProjectId) =>
  `${projectId}-workspace-state`;

/**
 * Decode untrusted stack configuration. Unknown keys fail, so a pasted
 * `value` or credential field never reaches a resource; known secret
 * shapes fail under any key.
 */
export const decodeWorkspaceStackConfig = (input: unknown) =>
  Effect.gen(function* () {
    const secretPaths = findSecretMaterial(input);
    if (secretPaths.length > 0) {
      return yield* new WorkspaceStackConfigInvalid({
        paths: secretPaths,
        reason: "secret-material",
      });
    }
    const config = yield* Schema.decodeUnknownEffect(WorkspaceStackConfig)(
      input,
      { onExcessProperty: "error", errors: "all" }
    ).pipe(
      Effect.mapError(
        (error) =>
          new WorkspaceStackConfigInvalid({
            paths: issuePaths(error.issue),
            reason: "schema",
          })
      )
    );
    const identityPaths = [
      ...serviceAccountProblems(config),
      ...(config.stateBucket === workspaceStateBucket(config.projectId)
        ? []
        : ["stateBucket"]),
    ];
    if (identityPaths.length > 0) {
      return yield* new WorkspaceStackConfigInvalid({
        paths: identityPaths,
        reason: "identity",
      });
    }
    const edgePaths = edgeProblems(config);
    if (edgePaths.length > 0) {
      return yield* new WorkspaceStackConfigInvalid({
        paths: edgePaths,
        reason: "edge",
      });
    }
    return config;
  });

/**
 * Preview declares no web service for an edge to front (#1455). Plain HTTP
 * is a sandbox proof mode in its approved project only. An HTTPS edge needs
 * at least one hostname, and no wildcard, for its managed certificate.
 */
const edgeProblems = (config: WorkspaceStackConfig) => {
  const edge = config.edge;
  if (edge === undefined) {
    return [];
  }
  if (config.stage === "preview") {
    return ["edge"];
  }
  if (!edge.enableHttps) {
    return config.stage === "sandbox" &&
      config.projectId === plainHttpEdgeProject
      ? []
      : ["edge.enableHttps"];
  }
  if (edge.domains.length === 0) {
    return ["edge.domains"];
  }
  return edge.domains.flatMap((host, index) =>
    isWildcardHost(host) ? [`edge.domains.${index}`] : []
  );
};

/**
 * Each role has its own service account, and every account lives in the
 * stage's own project, so one stage's identity never acts in another.
 */
const serviceAccountProblems = (config: WorkspaceStackConfig) => {
  const entries = Object.entries(config.serviceAccounts);
  return entries
    .filter(
      ([role, email]) =>
        !email.endsWith(`@${config.projectId}.iam.gserviceaccount.com`) ||
        entries.some(
          ([other, otherEmail]) => other !== role && otherEmail === email
        )
    )
    .map(([role]) => `serviceAccounts.${role}`);
};

/**
 * The configuration as it may appear in logs, plans and stack outputs.
 * Decoding already rejected secret material, so the encoded form holds
 * only identifiers and pinned secret versions.
 */
export const serializeWorkspaceStackConfig = (config: WorkspaceStackConfig) =>
  JSON.stringify(Schema.encodeSync(WorkspaceStackConfig)(config));

/**
 * The stage config CI supplies as JSON in `WORKSPACE_STACK_CONFIG`; it
 * alone selects project, stage and state for the stack and the release flow.
 */
export const configuredWorkspaceStack = Config.String(
  "WORKSPACE_STACK_CONFIG"
).pipe(
  Effect.flatMap((raw) =>
    Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(raw)
  ),
  Effect.flatMap(decodeWorkspaceStackConfig)
);
