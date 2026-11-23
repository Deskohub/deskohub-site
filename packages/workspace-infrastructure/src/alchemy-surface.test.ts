import { describe, expect, test } from "bun:test";
import * as ArtifactRegistry from "@alchemy.run/gcp/ArtifactRegistry";
import * as CloudScheduler from "@alchemy.run/gcp/CloudScheduler";
import * as CloudTasks from "@alchemy.run/gcp/CloudTasks";
import * as IAM from "@alchemy.run/gcp/IAM";
import * as Monitoring from "@alchemy.run/gcp/Monitoring";
import * as Run from "@alchemy.run/gcp/Run";
import * as Storage from "@alchemy.run/gcp/Storage";
import { isOutput } from "alchemy/Output";
import { Stack } from "alchemy/Stack";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import packageJson from "../package.json";
import { ImageDigest } from "./config/stack-config";
import {
  productionConfig,
  sandboxConfig,
} from "./config/stack-config.test-utils";
import { promote, settleApply, stage } from "./release/release-reconciler";
import { emptyReleaseRecord, GitSha } from "./release/release-record";
import {
  alertPolicyDeclarations,
  artifactRepositoryProps,
  mobileUpdatesBucketProps,
  mobileUpdatesPublisherGrant,
  secretAccessorGrants,
  workerInvokerGrants,
} from "./resources/platform-declarations";
import {
  webServiceProps,
  workerServiceProps,
} from "./resources/service-declarations";
import { workspaceSurfaceClassification } from "./surface-classification";
import {
  declareWorkspaceFoundation,
  declareWorkspaceServices,
} from "./workspace-stack";

type RegisteredResource = {
  readonly Type: string;
  // biome-ignore lint/suspicious/noExplicitAny: Alchemy registers raw input props.
  readonly Props: any;
};

/**
 * Evaluate a declaration against an empty in-memory stack. Registration
 * runs the real beta.87 constructors (and their logical-ID checks) without
 * providers, state or credentials.
 */
const evaluate = async <A, E, R>(declaration: Effect.Effect<A, E, R>) => {
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

const countBy = (values: ReadonlyArray<string>) => {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
};

const installedVersion = async (name: string) =>
  (
    await Bun.file(
      new URL(`../node_modules/${name}/package.json`, import.meta.url)
    ).json()
  ).version;

const now = DateTime.makeUnsafe("2026-11-22T10:00:00Z");
const digest = ImageDigest.make(`sha256:${"1".repeat(64)}`);

/** A record whose first release is serving. */
const servingRecord = () => {
  const staged = Effect.runSync(
    stage(emptyReleaseRecord, {
      expectedGeneration: 0,
      sha: GitSha.make("a".repeat(40)),
      imageDigest: digest,
      origin: "cloud-run",
    })
  );
  const pending = Effect.runSync(
    promote(staged.record, {
      expectedGeneration: 1,
      releaseId: staged.releaseId,
      now,
      candidateReadback: null,
    })
  );
  return Effect.runSync(
    settleApply(pending, {
      expectedGeneration: 2,
      readback: {
        servingRevision: "workspace-web-r1-aaaaaaa",
        servingImageDigest: digest,
      },
      now,
    })
  );
};

describe("Alchemy beta.87 surface", () => {
  test("pins exact versions and installs exactly them", async () => {
    expect(packageJson.dependencies).toEqual({
      "@alchemy.run/gcp": "2.0.0-beta.87",
      "@effect/platform-bun": "4.1.4",
      "@effect/platform-node": "4.1.4",
      alchemy: "2.0.0-beta.87",
      effect: "4.1.4",
    });
    expect(await installedVersion("@alchemy.run/gcp")).toBe("2.0.0-beta.87");
    expect(await installedVersion("alchemy")).toBe("2.0.0-beta.87");
    expect(await installedVersion("effect")).toBe("4.1.4");
  });

  test("names only resource types the installed provider defines", () => {
    const constructors: Record<string, { readonly Type?: unknown }> = {
      "GCP.ArtifactRegistry.Repository": ArtifactRegistry.Repository,
      "GCP.CloudScheduler.Job": CloudScheduler.Job,
      "GCP.CloudTasks.Queue": CloudTasks.Queue,
      "GCP.IAM.Member": IAM.Member,
      "GCP.Monitoring.AlertPolicy": Monitoring.AlertPolicy,
      "GCP.Storage.Bucket": Storage.Bucket,
    };
    const alchemyOwned = workspaceSurfaceClassification.flatMap((item) =>
      item.owner.kind === "alchemy" ? [item.owner.resourceType] : []
    );
    for (const resourceType of alchemyOwned) {
      if (resourceType === "GCP.Run.Service") {
        expect(typeof Run.Service).toBe("function");
        continue;
      }
      expect(constructors[resourceType]?.Type).toBe(resourceType);
    }
    expect(
      workspaceSurfaceClassification
        .filter((item) => item.owner.kind === "terraform")
        .map((item) => item.capability)
    ).toEqual([
      "External HTTPS load balancer and serverless NEG",
      "Cloud Armor security policy",
      "Cloud CDN policy",
      "Log Router exclusions for token-bearing routes",
    ]);
  });

  test("registers every foundation resource under a distinct logical ID", async () => {
    const enabled = await evaluate(
      declareWorkspaceFoundation({ ...sandboxConfig, schedulesEnabled: true })
    );
    expect(enabled.exit._tag).toBe("Success");
    const types = Object.values(enabled.resources).map((entry) => entry.Type);
    expect(countBy(types)).toEqual({
      "GCP.ArtifactRegistry.Repository": 1,
      "GCP.Storage.Bucket": 1,
      "GCP.IAM.Member": 1,
      "GCP.CloudTasks.Queue": 6,
      "GCP.CloudScheduler.Job": 10,
      "GCP.Monitoring.AlertPolicy": 3,
    });
    // The publisher grant names the declared bucket's output.
    expect(isOutput(enabled.resources.MobileUpdatesPublisher?.Props.name)).toBe(
      true
    );
  });

  test("declares no Scheduler job where schedules are not authorized", async () => {
    const disabled = await evaluate(declareWorkspaceFoundation(sandboxConfig));
    expect(disabled.exit._tag).toBe("Success");
    expect(
      Object.values(disabled.resources).filter(
        (entry) => entry.Type === "GCP.CloudScheduler.Job"
      )
    ).toEqual([]);
  });

  test("orders service grants by output references", async () => {
    const initial = await evaluate(
      declareWorkspaceServices(sandboxConfig, emptyReleaseRecord, now)
    );
    expect(initial.exit._tag).toBe("Success");
    expect(initial.resources).toEqual({});

    const served = await evaluate(
      Effect.gen(function* () {
        yield* declareWorkspaceFoundation(sandboxConfig);
        return yield* declareWorkspaceServices(
          sandboxConfig,
          servingRecord(),
          now
        );
      })
    );
    expect(served.exit._tag).toBe("Success");
    const { resources } = served;
    expect(
      countBy(Object.values(resources).map((entry) => entry.Type))
    ).toMatchObject({
      "GCP.Run.Service": 3,
      "GCP.IAM.Member": 5,
    });
    for (const id of ["TasksWorkerInvoker", "SchedulerWorkerInvoker"]) {
      expect(isOutput(resources[id]?.Props.name)).toBe(true);
    }
    const secretOf = (id: string) =>
      resources[id]?.Props.template.containers[0].env.find(
        (env: { name: string }) => env.name === "DATABASE_URL"
      )?.valueSource.secretKeyRef;
    for (const id of ["WorkspaceWeb", "WorkspaceTasksWorker"]) {
      expect(isOutput(secretOf(id)?.secret)).toBe(true);
      expect(secretOf(id)?.version).toBe("3");
    }
    expect(secretOf("WorkspaceSchedulerWorker")).toBeUndefined();
  });

  test("plans private workers by digest with distinct audiences", () => {
    const tasks = workerServiceProps(sandboxConfig, "tasks-worker", digest);
    const scheduler = workerServiceProps(
      sandboxConfig,
      "scheduler-worker",
      digest
    );
    expect(tasks).toMatchObject({
      serviceId: "workspace-tasks-worker",
      ingress: "INGRESS_TRAFFIC_INTERNAL_ONLY",
      invokerIamDisabled: false,
      customAudiences: ["workspace:deskohub-ws-sandbox:workspace-tasks-worker"],
      template: {
        serviceAccount: sandboxConfig.serviceAccounts.tasksWorkerRuntime,
        timeout: "300s",
        scaling: { minInstanceCount: 0, maxInstanceCount: 1 },
      },
    });
    expect(tasks.template?.containers?.[0]).toMatchObject({
      image: `europe-west1-docker.pkg.dev/deskohub-ws-sandbox/workspace/workspace@${digest}`,
      env: [
        { name: "WORKSPACE_RUNTIME_ROLE", value: "tasks-worker" },
        {
          name: "DATABASE_URL",
          valueSource: {
            secretKeyRef: {
              secret:
                "projects/deskohub-ws-sandbox/secrets/workspace-database-url",
              version: "3",
            },
          },
        },
      ],
    });
    expect(scheduler.customAudiences).not.toEqual(tasks.customAudiences);
    // The secret is not granted to the scheduler worker.
    expect(scheduler.template?.containers?.[0]).toMatchObject({
      env: [{ name: "WORKSPACE_RUNTIME_ROLE", value: "scheduler-worker" }],
    });
  });

  test("plans the web service from the release record only", () => {
    expect(
      webServiceProps(sandboxConfig, emptyReleaseRecord, now)
    ).toBeUndefined();
    const staged = Effect.runSync(
      stage(emptyReleaseRecord, {
        expectedGeneration: 0,
        sha: GitSha.make("a".repeat(40)),
        imageDigest: digest,
        origin: "cloud-run",
      })
    );
    const pending = Effect.runSync(
      promote(staged.record, {
        expectedGeneration: 1,
        releaseId: staged.releaseId,
        now,
        candidateReadback: null,
      })
    );
    expect(webServiceProps(sandboxConfig, pending, now)).toMatchObject({
      serviceId: "workspace-web",
      ingress: "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
      defaultUriDisabled: true,
      template: { revision: "workspace-web-r1-aaaaaaa" },
      traffic: [{ revision: "workspace-web-r1-aaaaaaa", percent: 100 }],
    });
  });

  test("plans platform resources with least-privilege grants", () => {
    expect(artifactRepositoryProps(sandboxConfig)).toMatchObject({
      format: "DOCKER",
      dockerConfig: { immutableTags: true },
    });
    expect(mobileUpdatesBucketProps(sandboxConfig)).toMatchObject({
      location: "EUROPE-WEST1",
      versioning: true,
      uniformBucketLevelAccess: true,
      forceDestroy: true,
    });
    expect(mobileUpdatesBucketProps(productionConfig).forceDestroy).toBe(false);
    expect(
      [
        ...workerInvokerGrants(sandboxConfig),
        ...secretAccessorGrants(sandboxConfig),
        mobileUpdatesPublisherGrant(sandboxConfig),
      ].map(({ props }) => [
        props.name.split("/").at(-1),
        props.role,
        props.member,
      ])
    ).toEqual([
      [
        "workspace-tasks-worker",
        "roles/run.invoker",
        `serviceAccount:${sandboxConfig.serviceAccounts.tasksInvoker}`,
      ],
      [
        "workspace-scheduler-worker",
        "roles/run.invoker",
        `serviceAccount:${sandboxConfig.serviceAccounts.schedulerInvoker}`,
      ],
      [
        "workspace-database-url",
        "roles/secretmanager.secretAccessor",
        `serviceAccount:${sandboxConfig.serviceAccounts.webRuntime}`,
      ],
      [
        "workspace-database-url",
        "roles/secretmanager.secretAccessor",
        `serviceAccount:${sandboxConfig.serviceAccounts.tasksWorkerRuntime}`,
      ],
      [
        "deskohub-ws-sandbox-mobile-updates",
        "roles/storage.objectCreator",
        `serviceAccount:${sandboxConfig.serviceAccounts.mobileUpdatesPublisher}`,
      ],
    ]);
    expect(alertPolicyDeclarations(sandboxConfig).map(({ id }) => id)).toEqual([
      "QueueBacklogAlert",
      "ServerErrorRateAlert",
      "SchedulerFailureAlert",
    ]);
  });
});
