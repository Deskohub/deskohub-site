import { describe, expect, test } from "bun:test";
import * as ArtifactRegistry from "@alchemy.run/gcp/ArtifactRegistry";
import * as CloudScheduler from "@alchemy.run/gcp/CloudScheduler";
import * as CloudTasks from "@alchemy.run/gcp/CloudTasks";
import * as Compute from "@alchemy.run/gcp/Compute";
import * as IAM from "@alchemy.run/gcp/IAM";
import * as Logging from "@alchemy.run/gcp/Logging";
import * as Monitoring from "@alchemy.run/gcp/Monitoring";
import * as Run from "@alchemy.run/gcp/Run";
import * as Storage from "@alchemy.run/gcp/Storage";
import { isOutput } from "alchemy/Output";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import packageJson from "../package.json";
import {
  decodeWorkspaceStackConfig,
  ImageDigest,
  type WorkspaceStackConfig,
} from "./config/stack-config";
import {
  previewConfig,
  productionConfig,
  sandboxConfig,
  sandboxConfigInput,
} from "./config/stack-config.test-utils";
import { workspaceQueueContracts } from "./contracts/queue-contracts";
import { workspaceScheduleContracts } from "./contracts/schedule-contracts";
import { ReleaseServiceReadback } from "./release/release-platform";
import { workersServing } from "./release/release-readback.test-utils";
import { promote, settleApply, stage } from "./release/release-reconciler";
import {
  emptyReleaseRecord,
  GitSha,
  type ReleaseRecord,
} from "./release/release-record";
import {
  makeInMemoryReleaseRecordStore,
  ReleaseRecordStore,
} from "./release/release-record-store";
import { requireStackWriter } from "./release/release-writer";
import {
  heldBy,
  runAsHolder,
  testWriterToken,
} from "./release/release-writer.test-utils";
import { EdgeBackendService } from "./resources/edge-backend-service";
import { declareWorkspaceEdge } from "./resources/edge-declarations";
import { EdgeSecurityPolicy } from "./resources/edge-security-policy";
import {
  alertPolicyDeclarations,
  artifactRepositoryProps,
  mobileUpdatesBucketProps,
  mobileUpdatesPublisherGrant,
  secretAccessorGrants,
  workerInvokerGrants,
} from "./resources/platform-declarations";
import { queueProps } from "./resources/queue-declarations";
import { scheduleJobProps } from "./resources/schedule-declarations";
import {
  templateSpecAnnotation,
  webServiceProps,
  webTemplateSpecFingerprint,
  workerServiceProps,
} from "./resources/service-declarations";
import { evaluate } from "./stack-evaluation.test-utils";
import { workspaceSurfaceClassification } from "./surface-classification";
import {
  declareRecordedWorkspaceServices,
  declareWorkspaceFoundation,
  declareWorkspaceServices,
} from "./workspace-stack";

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
      liveTemplate: null,
      now,
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
        trafficGeneration: 1,
      },
      workers: workersServing(digest),
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

  test("names only resource types the stack's providers define", () => {
    const constructors: Record<string, { readonly Type?: unknown }> = {
      "GCP.ArtifactRegistry.Repository": ArtifactRegistry.Repository,
      "GCP.CloudScheduler.Job": CloudScheduler.Job,
      "GCP.CloudTasks.Queue": CloudTasks.Queue,
      "GCP.Compute.GlobalAddress": Compute.GlobalAddress,
      "GCP.Compute.GlobalForwardingRule": Compute.GlobalForwardingRule,
      "GCP.Compute.RegionNetworkEndpointGroup":
        Compute.RegionNetworkEndpointGroup,
      "GCP.Compute.SslCertificate": Compute.SslCertificate,
      "GCP.Compute.TargetHttpProxy": Compute.TargetHttpProxy,
      "GCP.Compute.TargetHttpsProxy": Compute.TargetHttpsProxy,
      "GCP.Compute.UrlMap": Compute.UrlMap,
      "GCP.IAM.Member": IAM.Member,
      "GCP.Logging.Exclusion": Logging.Exclusion,
      "GCP.Monitoring.AlertPolicy": Monitoring.AlertPolicy,
      "GCP.Storage.Bucket": Storage.Bucket,
      "DeskohubWorkspace.EdgeBackendService": EdgeBackendService,
      "DeskohubWorkspace.EdgeSecurityPolicy": EdgeSecurityPolicy,
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
    // The edge has no Terraform owner left.
    expect(
      new Set(workspaceSurfaceClassification.map((item) => item.owner.kind))
    ).toEqual(
      new Set(["alchemy", "owner-bootstrap", "release-flow", "deferred"])
    );
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
      "GCP.IAM.Member": 2,
      "GCP.CloudTasks.Queue": 6,
      "GCP.CloudScheduler.Job": 10,
      "GCP.Monitoring.AlertPolicy": 3,
    });
    // Both publisher grants name the declared bucket's output.
    for (const id of ["MobileUpdatesPublisher", "MobileUpdatesPublisherRead"]) {
      expect(isOutput(enabled.resources[id]?.Props.name)).toBe(true);
    }
    expect(enabled.resources.MobileUpdatesPublisherRead?.Props.role).toBe(
      "roles/storage.legacyObjectReader"
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

  test("fails closed for preview services until IAP exists", async () => {
    const preview = await evaluate(
      declareWorkspaceServices(previewConfig, servingRecord(), now)
    );
    expect(preview.exit._tag).toBe("Failure");
    expect(preview.resources).toEqual({});
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
      "GCP.IAM.Member": 6,
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

  test("points the edge's endpoint group at the declared web service ID", async () => {
    const served = await evaluate(
      Effect.gen(function* () {
        const services = yield* declareWorkspaceServices(
          sandboxConfig,
          servingRecord(),
          now
        );
        return yield* declareWorkspaceEdge(
          sandboxConfig,
          {
            domains: ["workspace.example.com"],
            enableHttps: true,
            staticCdnEnabled: false,
            wafPreview: true,
            authRateLimitPerMinute: 120,
          },
          services?.webServiceId
        );
      })
    );
    expect(served.exit._tag).toBe("Success");
    const { resources } = served;
    // The NEG takes the short ID, the same as its fallback, by reference.
    expect(resources.WorkspaceWeb?.Props.serviceId).toBe("workspace-web");
    expect(
      isOutput(resources.EdgeWebEndpointGroup?.Props.cloudRun.service)
    ).toBe(true);
  });

  test("declares services only from the record at the fenced generation", async () => {
    const record = servingRecord();
    const fromStore = (expectedGeneration: number | null) =>
      Effect.gen(function* () {
        const store = yield* makeInMemoryReleaseRecordStore(
          heldBy(record, expectedGeneration === null ? "deploy" : "deliver")
        );
        return yield* declareRecordedWorkspaceServices(
          sandboxConfig,
          runAsHolder(expectedGeneration)
        ).pipe(Effect.provideService(ReleaseRecordStore, store));
      });

    const stale = await evaluate(fromStore(record.generation - 1));
    expect(stale.exit._tag).toBe("Failure");
    expect(String(stale.exit)).toContain("StaleReleaseGeneration");
    expect(stale.resources).toEqual({});

    for (const fenced of [record.generation, null]) {
      const applied = await evaluate(fromStore(fenced));
      expect(applied.exit._tag).toBe("Success");
      expect(
        Object.values(applied.resources).filter(
          (entry) => entry.Type === "GCP.Run.Service"
        )
      ).toHaveLength(3);
    }
  });

  test("a plain deploy refuses a pending traffic change but keeps a candidate", async () => {
    const plain = (record: ReleaseRecord) =>
      evaluate(
        Effect.gen(function* () {
          const store = yield* makeInMemoryReleaseRecordStore(
            heldBy(record, "deploy")
          );
          return yield* declareRecordedWorkspaceServices(
            sandboxConfig,
            runAsHolder(null)
          ).pipe(Effect.provideService(ReleaseRecordStore, store));
        })
      );
    const serving = servingRecord();
    const { record: candidate, releaseId } = Effect.runSync(
      stage(serving, {
        expectedGeneration: serving.generation,
        sha: GitSha.make("b".repeat(40)),
        imageDigest: digest,
        origin: "cloud-run",
        liveTemplate: null,
        now,
      })
    );
    const pending = Effect.runSync(
      promote(candidate, {
        expectedGeneration: candidate.generation,
        releaseId,
        now,
        candidateReadback: candidate.candidate,
      })
    );

    const staged = await plain(candidate);
    expect(staged.exit._tag).toBe("Success");
    const refused = await plain(pending);
    expect(String(refused.exit)).toContain("ReleaseApplyPending");
    expect(refused.resources).toEqual({});
  });

  test("a plan declares the web template its following deploy decides", async () => {
    const record = servingRecord();
    // Cloud Run runs the release's template from an older spec.
    const olderSpec = ReleaseServiceReadback.of({
      service: (workload) =>
        Effect.succeed(
          workload === "web"
            ? {
                workload,
                uri: undefined,
                urls: [],
                ingress: "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
                invokerIamDisabled: true,
                terminalConditionState: "CONDITION_SUCCEEDED",
                reconciling: false,
                traffic: [
                  { revision: "workspace-web-r1-aaaaaaa", percent: 100 },
                ],
                revisionDigests: { "workspace-web-r1-aaaaaaa": digest },
                annotations: {},
                templateRevision: "workspace-web-r1-aaaaaaa",
                templateImageDigest: digest,
                templateSpecFingerprint: "spec-older",
                templateReady: true,
              }
            : null
        ),
      revision: () => Effect.succeed(null),
    });
    const declareAs = (operation: "plan" | "deploy") =>
      evaluate(
        Effect.gen(function* () {
          const store = yield* makeInMemoryReleaseRecordStore(
            heldBy(record, operation)
          );
          const services = yield* declareRecordedWorkspaceServices(
            sandboxConfig,
            runAsHolder(null)
          ).pipe(
            Effect.provideService(ReleaseRecordStore, store),
            Effect.provideService(ReleaseServiceReadback, olderSpec)
          );
          return { services, stored: (yield* store.read).record };
        })
      );

    const planned = await declareAs("plan");
    expect(planned.exit._tag).toBe("Success");
    const template = planned.resources.WorkspaceWeb?.Props.template;
    expect(template?.revision).toBe(
      `workspace-web-r1-aaaaaaa-t${record.generation + 1}`
    );
    expect(template?.annotations?.[templateSpecAnnotation]).toBe(
      webTemplateSpecFingerprint(sandboxConfig, digest)
    );
    // The plan persisted nothing; a deploy persists the decision first.
    if (planned.exit._tag === "Success") {
      expect(planned.exit.value.stored).toEqual(heldBy(record, "plan"));
    }
    const deployed = await declareAs("deploy");
    expect(deployed.resources.WorkspaceWeb?.Props.template?.revision).toBe(
      "workspace-web-r1-aaaaaaa"
    );
  });

  test("refuses an empty record while the web service is live", async () => {
    const liveWeb = (live: boolean) =>
      ReleaseServiceReadback.of({
        service: (workload) =>
          Effect.succeed(
            live && workload === "web"
              ? {
                  workload,
                  uri: undefined,
                  urls: [],
                  ingress: "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
                  invokerIamDisabled: true,
                  terminalConditionState: "CONDITION_SUCCEEDED",
                  reconciling: false,
                  traffic: [
                    { revision: "workspace-web-r3-aaaaaaa", percent: 100 },
                  ],
                  revisionDigests: {},
                  annotations: {},
                }
              : null
          ),
        revision: () => Effect.succeed(null),
      });
    const declare = (live: boolean) =>
      evaluate(
        Effect.gen(function* () {
          const store = yield* makeInMemoryReleaseRecordStore(
            heldBy(emptyReleaseRecord, "deploy")
          );
          return yield* declareRecordedWorkspaceServices(
            sandboxConfig,
            runAsHolder(null)
          ).pipe(
            Effect.provideService(ReleaseRecordStore, store),
            Effect.provideService(ReleaseServiceReadback, liveWeb(live))
          );
        })
      );

    const lost = await declare(true);
    expect(lost.exit._tag).toBe("Failure");
    expect(String(lost.exit)).toContain("ReleaseRecordLost");
    expect(lost.resources).toEqual({});

    const fresh = await declare(false);
    expect(fresh.exit._tag).toBe("Success");
    expect(fresh.resources).toEqual({});
  });

  test("declares no preview services and refuses a fenced preview apply", async () => {
    const preview = (expectedGeneration: number | null) =>
      evaluate(
        Effect.gen(function* () {
          const store = yield* makeInMemoryReleaseRecordStore(servingRecord());
          return yield* declareRecordedWorkspaceServices(previewConfig, {
            writer: Option.none(),
            generation: expectedGeneration,
          }).pipe(Effect.provideService(ReleaseRecordStore, store));
        })
      );
    const plain = await preview(null);
    expect(plain.exit._tag).toBe("Success");
    expect(plain.resources).toEqual({});
    const fenced = await preview(2);
    expect(fenced.exit._tag).toBe("Failure");
    expect(fenced.resources).toEqual({});
  });

  test("the stack refuses a run without the held lock's token", async () => {
    const record = heldBy(servingRecord(), "deploy");
    const check = (
      config: typeof sandboxConfig,
      writer: Option.Option<Redacted.Redacted<string>>
    ) =>
      Effect.runPromiseExit(
        Effect.gen(function* () {
          const store = yield* makeInMemoryReleaseRecordStore(record);
          return yield* requireStackWriter(config, writer).pipe(
            Effect.provideService(ReleaseRecordStore, store)
          );
        })
      );
    expect(String(await check(sandboxConfig, Option.none()))).toContain(
      "ReleaseWriterRequired"
    );
    expect(
      String(await check(sandboxConfig, Option.some(Redacted.make("other"))))
    ).toContain("ReleaseWriterLost");
    expect(
      (await check(sandboxConfig, Option.some(testWriterToken)))._tag
    ).toBe("Success");
    // Preview needs no lock and never reads the record.
    const preview = await Effect.runPromiseExit(
      requireStackWriter(previewConfig, Option.none()).pipe(
        Effect.provideService(
          ReleaseRecordStore,
          ReleaseRecordStore.of({
            read: Effect.die("preview read the record"),
            write: () => Effect.die("preview wrote the record"),
          })
        )
      )
    );
    expect(preview._tag).toBe("Success");
  });

  test("the lock's operation decides whether the stack run is fenced", async () => {
    const record = servingRecord();
    const declare = (
      operation: "deploy" | "deliver",
      generation: number | null
    ) =>
      evaluate(
        Effect.gen(function* () {
          const store = yield* makeInMemoryReleaseRecordStore(
            heldBy(record, operation)
          );
          return yield* declareRecordedWorkspaceServices(
            sandboxConfig,
            runAsHolder(generation)
          ).pipe(Effect.provideService(ReleaseRecordStore, store));
        })
      );
    // An inherited generation never turns a plain deploy into a fenced one.
    const inherited = await declare("deploy", record.generation);
    expect(String(inherited.exit)).toContain("ReleaseWriterModeMismatch");
    expect(inherited.resources).toEqual({});
    const unfenced = await declare("deliver", null);
    expect(String(unfenced.exit)).toContain("ReleaseWriterModeMismatch");
    expect(unfenced.resources).toEqual({});
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
      customAudiences: [
        "https://workspace-tasks-worker-123456789012.europe-west1.run.app",
      ],
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
          name: "WORKSPACE_TASKS_AUDIENCE",
          value: tasks.customAudiences?.[0],
        },
        {
          name: "WORKSPACE_TASKS_INVOKER_EMAIL",
          value: sandboxConfig.serviceAccounts.tasksInvoker,
        },
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
      env: [
        { name: "WORKSPACE_RUNTIME_ROLE", value: "scheduler-worker" },
        {
          name: "WORKSPACE_SCHEDULER_AUDIENCE",
          value: scheduler.customAudiences?.[0],
        },
        {
          name: "WORKSPACE_SCHEDULER_INVOKER_EMAIL",
          value: sandboxConfig.serviceAccounts.schedulerInvoker,
        },
      ],
    });
  });

  test("workers accept the invokers their queues and schedules sign as", () => {
    const record = servingRecord();
    const [queueContract] = workspaceQueueContracts;
    const [scheduleContract] = workspaceScheduleContracts;
    if (queueContract === undefined || scheduleContract === undefined) {
      throw new Error("expected a queue and a schedule contract");
    }
    const queueTarget = queueProps(sandboxConfig, queueContract);
    const jobTarget = scheduleJobProps(sandboxConfig, scheduleContract);
    const environment = (workload: "tasks-worker" | "scheduler-worker") => {
      const containers = (workerServiceProps(sandboxConfig, workload, digest)
        .template?.containers ?? []) as Array<{
        env: Array<{ name: string; value: string }>;
      }>;
      const [app] = containers;
      return Object.fromEntries(
        (app?.env ?? []).map(({ name, value }) => [name, value])
      );
    };
    expect(environment("tasks-worker")).toMatchObject({
      WORKSPACE_TASKS_AUDIENCE: queueTarget.httpTarget?.oidcToken?.audience,
      WORKSPACE_TASKS_INVOKER_EMAIL:
        queueTarget.httpTarget?.oidcToken?.serviceAccountEmail,
    });
    expect(environment("scheduler-worker")).toMatchObject({
      WORKSPACE_SCHEDULER_AUDIENCE: jobTarget.httpTarget?.oidcToken?.audience,
      WORKSPACE_SCHEDULER_INVOKER_EMAIL:
        jobTarget.httpTarget?.oidcToken?.serviceAccountEmail,
    });
    // The public web service accepts no Google invoker.
    const web = webServiceProps(sandboxConfig, record, now);
    expect(
      JSON.stringify(web?.template?.containers?.[0]).includes("INVOKER")
    ).toBe(false);
  });

  test("adds the collector sidecar only when the stage names its image", () => {
    const record = servingRecord();
    const collectorDigest = `sha256:${"c".repeat(64)}`;
    const withCollector = Effect.runSync(
      decodeWorkspaceStackConfig({
        ...sandboxConfigInput,
        telemetryCollectorImage: collectorDigest,
      })
    );
    const declared = (config: WorkspaceStackConfig) => [
      webServiceProps(config, record, now),
      workerServiceProps(config, "tasks-worker", digest),
      workerServiceProps(config, "scheduler-worker", digest),
    ];

    // Without the field every service runs the app alone, unnamed.
    for (const props of declared(sandboxConfig)) {
      const containers = props?.template?.containers ?? [];
      expect(containers).toHaveLength(1);
      expect(containers[0]).not.toHaveProperty("name");
      expect(containers[0]).not.toHaveProperty("dependsOn");
      expect(JSON.stringify(containers)).not.toContain("OTLP");
    }

    for (const props of declared(withCollector)) {
      const [app, collector, ...rest] = (props?.template?.containers ??
        []) as Array<Record<string, unknown>>;
      expect(rest).toEqual([]);
      // The app stays first, so readback reads its image as the template's.
      expect(app).toMatchObject({
        name: "workspace",
        image: `europe-west1-docker.pkg.dev/deskohub-ws-sandbox/workspace/workspace@${digest}`,
        ports: [{ containerPort: 8080 }],
        dependsOn: ["otel-collector"],
      });
      expect(app?.env).toContainEqual({
        name: "WORKSPACE_OTLP_ENDPOINT",
        value: "http://127.0.0.1:4318",
      });
      // Only the app takes ingress; the collector serves its health port.
      expect(collector).toEqual({
        name: "otel-collector",
        image: `europe-west1-docker.pkg.dev/deskohub-ws-sandbox/workspace/workspace-otel-collector@${collectorDigest}`,
        startupProbe: expect.objectContaining({
          httpGet: { path: "/", port: 13133 },
        }),
        livenessProbe: expect.objectContaining({
          httpGet: { path: "/", port: 13133 },
        }),
      });
    }

    // The sidecar is part of the web spec, so it mints its own revision.
    expect(webTemplateSpecFingerprint(withCollector, digest)).not.toBe(
      webTemplateSpecFingerprint(sandboxConfig, digest)
    );
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
        liveTemplate: null,
        now,
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
