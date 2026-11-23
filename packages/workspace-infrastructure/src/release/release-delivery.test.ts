import { describe, expect, test } from "bun:test";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { ImageDigest, type WorkspaceWorkload } from "../config/stack-config";
import { sandboxConfig } from "../config/stack-config.test-utils";
import type { ObservedService } from "../readback";
import { webServiceProps } from "../resources/service-declarations";
import { workloadUrl } from "../resources/workload-names";
import {
  deliverRelease,
  type ReleaseReadbackPolicy,
  readFencedReleaseRecord,
  recoverRelease,
  restoreRelease,
} from "./release-delivery";
import {
  ReleaseServiceApply,
  ReleaseServiceApplyFailed,
  ReleaseServiceReadback,
} from "./release-platform";
import { stage } from "./release-reconciler";
import { emptyReleaseRecord, GitSha, ReleaseId } from "./release-record";
import {
  makeInMemoryReleaseRecordStore,
  ReleaseRecordStore,
  runReleaseStep,
} from "./release-record-store";

const shaA = GitSha.make("a".repeat(40));
const shaB = GitSha.make("b".repeat(40));
const shaC = GitSha.make("c".repeat(40));
const digestA = ImageDigest.make(`sha256:${"1".repeat(64)}`);
const digestB = ImageDigest.make(`sha256:${"2".repeat(64)}`);
const digestC = ImageDigest.make(`sha256:${"3".repeat(64)}`);

const policy: ReleaseReadbackPolicy = {
  attempts: 3,
  spacing: Duration.zero,
};

interface FakeCloudRunOptions {
  /** Fail the apply of these generations as if the run died mid-apply. */
  readonly interruptApplyOf?: ReadonlySet<number>;
  /** Readback keeps showing the old traffic for this many reads per apply. */
  readonly trafficLagReads?: number;
  /** The digest Cloud Run reports for the next materialized revision. */
  readonly resolvedDigest?: ImageDigest;
  /** Runs before each candidate revision read, e.g. a competing writer. */
  readonly beforeRevisionRead?: Effect.Effect<
    void,
    unknown,
    ReleaseRecordStore
  >;
  /** The ingress Cloud Run reports for the tasks worker. */
  readonly tasksWorkerIngress?: string;
}

/**
 * A Cloud Run project that applies the web service exactly as the release
 * record declares it, read under the apply's generation fence.
 */
const makeFakeCloudRun = (options: FakeCloudRunOptions = {}) =>
  Effect.gen(function* () {
    const store = yield* ReleaseRecordStore;
    const applies: Array<number> = [];
    const revisions = new Map<string, ImageDigest>();
    let web: ObservedService | null = null;
    let visible: ObservedService | null = null;
    let lagReads = 0;
    let workersDeployed = false;

    const apply = ReleaseServiceApply.of({
      apply: (generation) =>
        Effect.gen(function* () {
          applies.push(generation);
          const record = yield* readFencedReleaseRecord(generation).pipe(
            Effect.provideService(ReleaseRecordStore, store),
            Effect.mapError(
              (error) =>
                new ReleaseServiceApplyFailed({
                  generation,
                  reason: error._tag,
                })
            )
          );
          if (options.interruptApplyOf?.has(generation)) {
            return yield* new ReleaseServiceApplyFailed({
              generation,
              reason: "interrupted",
            });
          }
          const props = webServiceProps(
            sandboxConfig,
            record,
            yield* DateTime.now
          );
          if (props === undefined) {
            return;
          }
          const revision = props.template?.revision;
          const image = props.template?.containers?.[0]?.image;
          if (revision !== undefined && typeof image === "string") {
            revisions.set(
              revision,
              options.resolvedDigest ??
                ImageDigest.make(image.slice(image.indexOf("@") + 1))
            );
          }
          workersDeployed = true;
          web = {
            workload: "web",
            uri: undefined,
            urls: [],
            ingress: props.ingress,
            invokerIamDisabled: props.invokerIamDisabled === true,
            terminalConditionState: "CONDITION_SUCCEEDED",
            reconciling: false,
            traffic: (props.traffic ?? []).map((entry) => ({
              revision: entry.revision ?? "",
              percent: entry.percent ?? 0,
              tag: entry.tag,
            })),
            revisionDigests: Object.fromEntries(revisions),
            annotations: { ...props.annotations },
          };
          lagReads = options.trafficLagReads ?? 0;
        }),
    });

    const worker = (
      workload: Exclude<WorkspaceWorkload, "web">
    ): ObservedService => ({
      workload,
      uri: workloadUrl(sandboxConfig, workload),
      urls: [workloadUrl(sandboxConfig, workload)],
      ingress:
        workload === "tasks-worker"
          ? (options.tasksWorkerIngress ?? "INGRESS_TRAFFIC_INTERNAL_ONLY")
          : "INGRESS_TRAFFIC_INTERNAL_ONLY",
      invokerIamDisabled: false,
      terminalConditionState: "CONDITION_SUCCEEDED",
      reconciling: false,
      traffic: [],
      revisionDigests: {},
      annotations: {},
    });

    const readback = ReleaseServiceReadback.of({
      service: (workload) =>
        Effect.sync(() => {
          if (workload !== "web") {
            return workersDeployed ? worker(workload) : null;
          }
          if (lagReads > 0) {
            lagReads -= 1;
            return visible;
          }
          visible = web;
          return web;
        }),
      revision: (revision) =>
        (options.beforeRevisionRead ?? Effect.void).pipe(
          Effect.provideService(ReleaseRecordStore, store),
          Effect.orDie,
          Effect.as(
            revisions.has(revision)
              ? {
                  revision,
                  imageDigest: revisions.get(revision) ?? null,
                  ready: true,
                }
              : null
          )
        ),
    });

    return { apply, readback, applies };
  });

const setup = (options?: FakeCloudRunOptions) =>
  Effect.gen(function* () {
    const store = yield* makeInMemoryReleaseRecordStore(emptyReleaseRecord);
    const cloudRun = yield* makeFakeCloudRun(options).pipe(
      Effect.provideService(ReleaseRecordStore, store)
    );
    const provide = <A, E>(
      effect: Effect.Effect<
        A,
        E,
        ReleaseRecordStore | ReleaseServiceApply | ReleaseServiceReadback
      >
    ) =>
      effect.pipe(
        Effect.provideService(ReleaseRecordStore, store),
        Effect.provideService(ReleaseServiceApply, cloudRun.apply),
        Effect.provideService(ReleaseServiceReadback, cloudRun.readback)
      );
    return { store, applies: cloudRun.applies, provide };
  });

const errorOf = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit)) {
    throw new Error("expected a failure");
  }
  const reason = exit.cause.reasons[0];
  return reason?._tag === "Fail" ? reason.error : reason;
};

describe("fenced release delivery", () => {
  test("the first release creates the service and settles from readback", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { store, applies, provide } = yield* setup();
        const serving = yield* provide(
          deliverRelease(
            sandboxConfig,
            { sha: shaA, imageDigest: digestA },
            policy
          )
        );
        return { serving, stored: yield* store.read, applies };
      })
    );
    expect(result.serving).toMatchObject({
      releaseId: "r1-aaaaaaa",
      imageDigest: digestA,
      revision: "workspace-web-r1-aaaaaaa",
    });
    // Stage, promote and settle each advanced the record once.
    expect(result.serving.generation).toBe(3);
    // No candidate apply before the service exists; one traffic apply.
    expect(result.applies).toEqual([2]);
    expect(result.stored.record.pendingApply).toBeNull();
    expect(result.stored.record.active?.releaseId).toBe(
      ReleaseId.make("r1-aaaaaaa")
    );
  });

  test("a later release is verified as a zero-traffic revision before promotion", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { store, applies, provide } = yield* setup();
        yield* provide(
          deliverRelease(
            sandboxConfig,
            { sha: shaA, imageDigest: digestA },
            policy
          )
        );
        const serving = yield* provide(
          deliverRelease(
            sandboxConfig,
            { sha: shaB, imageDigest: digestB },
            policy
          )
        );
        return { serving, record: (yield* store.read).record, applies };
      })
    );
    expect(result.serving).toMatchObject({
      releaseId: "r4-bbbbbbb",
      imageDigest: digestB,
    });
    // Candidate materialization at the staged generation, then traffic.
    expect(result.applies).toEqual([2, 4, 5]);
    expect(result.record.previous?.releaseId).toBe(
      ReleaseId.make("r1-aaaaaaa")
    );
    expect(result.record.compatible.map((entry) => entry.releaseId)).toEqual([
      ReleaseId.make("r1-aaaaaaa"),
    ]);
  });

  test("restore returns traffic to the previous verified digest", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { store, provide } = yield* setup();
        yield* provide(
          deliverRelease(
            sandboxConfig,
            { sha: shaA, imageDigest: digestA },
            policy
          )
        );
        const promoted = yield* provide(
          deliverRelease(
            sandboxConfig,
            { sha: shaB, imageDigest: digestB },
            policy
          )
        );
        const restored = yield* provide(
          restoreRelease(
            sandboxConfig,
            {
              releaseId: promoted.releaseId,
              expectedGeneration: promoted.generation,
            },
            policy
          ).pipe(Effect.exit)
        );
        const previous = (yield* store.read).record.previous;
        const back = yield* provide(
          restoreRelease(
            sandboxConfig,
            {
              releaseId: previous?.releaseId ?? promoted.releaseId,
              expectedGeneration: promoted.generation,
            },
            policy
          )
        );
        return { restored, back, record: (yield* store.read).record };
      })
    );
    // The active release is not a restore target.
    expect(errorOf(result.restored)).toMatchObject({
      _tag: "ReleaseNotRestorable",
    });
    expect(result.back).toMatchObject({
      releaseId: "r1-aaaaaaa",
      imageDigest: digestA,
      revision: "workspace-web-r1-aaaaaaa",
    });
    expect(result.record.previous?.releaseId).toBe(
      ReleaseId.make("r4-bbbbbbb")
    );
  });

  test("a restore fenced on a superseded generation changes nothing", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { store, applies, provide } = yield* setup();
        const first = yield* provide(
          deliverRelease(
            sandboxConfig,
            { sha: shaA, imageDigest: digestA },
            policy
          )
        );
        yield* provide(
          deliverRelease(
            sandboxConfig,
            { sha: shaB, imageDigest: digestB },
            policy
          )
        );
        const before = yield* store.read;
        const appliesBefore = applies.length;
        const exit = yield* provide(
          restoreRelease(
            sandboxConfig,
            {
              releaseId: first.releaseId,
              expectedGeneration: first.generation,
            },
            policy
          ).pipe(Effect.exit)
        );
        return {
          exit,
          before,
          after: yield* store.read,
          newApplies: applies.length - appliesBefore,
        };
      })
    );
    expect(errorOf(result.exit)).toMatchObject({
      _tag: "StaleReleaseGeneration",
      expectedGeneration: 3,
      currentGeneration: 6,
    });
    expect(result.after).toEqual(result.before);
    expect(result.newApplies).toBe(0);
  });

  test("an interrupted traffic apply stays pending and recovery settles it", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { store, applies, provide } = yield* setup({
          interruptApplyOf: new Set([2]),
        });
        const interrupted = yield* provide(
          deliverRelease(
            sandboxConfig,
            { sha: shaA, imageDigest: digestA },
            policy
          ).pipe(Effect.exit)
        );
        const pending = (yield* store.read).record.pendingApply;
        return { interrupted, pending, store, applies, provide };
      })
    );
    expect(errorOf(result.interrupted)).toMatchObject({
      _tag: "ReleaseServiceApplyFailed",
      generation: 2,
    });
    expect(result.pending?.target.releaseId).toBe(ReleaseId.make("r1-aaaaaaa"));

    // The interruption was transient: the next run re-applies generation 2.
    const recovered = await Effect.runPromise(
      Effect.gen(function* () {
        const { provide } = yield* setup();
        return yield* provide(
          Effect.gen(function* () {
            // Seed the new run's store with the interrupted run's record.
            const store = yield* ReleaseRecordStore;
            const seeded = yield* store.read;
            yield* store.write(
              (yield* result.store.read).record,
              seeded.version
            );
            return yield* recoverRelease(sandboxConfig, policy);
          })
        );
      })
    );
    expect(recovered).toMatchObject({
      releaseId: "r1-aaaaaaa",
      imageDigest: digestA,
    });
  });

  test("recovery is a no-op without a pending apply", async () => {
    const recovered = await Effect.runPromise(
      Effect.gen(function* () {
        const { provide } = yield* setup();
        return yield* provide(recoverRelease(sandboxConfig, policy));
      })
    );
    expect(recovered).toBeNull();
  });

  test("lagging readback settles once traffic shows the target", async () => {
    const serving = await Effect.runPromise(
      Effect.gen(function* () {
        const { provide } = yield* setup({ trafficLagReads: 2 });
        return yield* provide(
          deliverRelease(
            sandboxConfig,
            { sha: shaA, imageDigest: digestA },
            policy
          )
        );
      })
    );
    expect(serving.releaseId).toBe(ReleaseId.make("r1-aaaaaaa"));
  });

  test("readback that never converges keeps the intent pending", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { store, provide } = yield* setup({
          trafficLagReads: policy.attempts,
        });
        const exit = yield* provide(
          deliverRelease(
            sandboxConfig,
            { sha: shaA, imageDigest: digestA },
            policy
          ).pipe(Effect.exit)
        );
        return { exit, record: (yield* store.read).record };
      })
    );
    expect(errorOf(result.exit)).toMatchObject({
      _tag: "ReleaseApplyNotObserved",
      intended: "r1-aaaaaaa",
    });
    expect(result.record.pendingApply?.target.releaseId).toBe(
      ReleaseId.make("r1-aaaaaaa")
    );
    expect(result.record.active).toBeNull();
  });

  test("a candidate whose resolved digest differs is never promoted", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { store, provide } = yield* setup();
        yield* provide(
          deliverRelease(
            sandboxConfig,
            { sha: shaA, imageDigest: digestA },
            policy
          )
        );
        const { provide: provideTampered } = yield* setup({
          resolvedDigest: digestC,
        });
        const exit = yield* provideTampered(
          Effect.gen(function* () {
            const seeded = yield* ReleaseRecordStore;
            yield* seeded.write(
              (yield* store.read).record,
              (yield* seeded.read).version
            );
            return yield* deliverRelease(
              sandboxConfig,
              { sha: shaB, imageDigest: digestB },
              policy
            );
          }).pipe(Effect.exit)
        );
        return { exit };
      })
    );
    expect(errorOf(result.exit)).toMatchObject({
      _tag: "CandidateNotVerified",
      releaseId: "r4-bbbbbbb",
    });
  });

  test("a competing run that stages first fences out the promotion", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        let competed = false;
        const { store, provide } = yield* setup({
          beforeRevisionRead: Effect.suspend(() => {
            if (competed) {
              return Effect.void;
            }
            competed = true;
            return runReleaseStep((record) =>
              stage(record, {
                expectedGeneration: record.generation,
                sha: shaC,
                imageDigest: digestC,
                origin: "cloud-run",
              }).pipe(
                Effect.map((staged) => ({
                  record: staged.record,
                  result: null,
                }))
              )
            );
          }),
        });
        yield* provide(
          deliverRelease(
            sandboxConfig,
            { sha: shaA, imageDigest: digestA },
            policy
          )
        );
        const exit = yield* provide(
          deliverRelease(
            sandboxConfig,
            { sha: shaB, imageDigest: digestB },
            policy
          ).pipe(Effect.exit)
        );
        return { exit, record: (yield* store.read).record };
      })
    );
    expect(errorOf(result.exit)).toMatchObject({
      _tag: "StaleReleaseGeneration",
      expectedGeneration: 4,
      currentGeneration: 5,
    });
    expect(result.record.candidate?.releaseId).toBe(
      ReleaseId.make("r5-ccccccc")
    );
    expect(result.record.pendingApply).toBeNull();
    expect(result.record.active?.releaseId).toBe(ReleaseId.make("r1-aaaaaaa"));
  });

  test("worker contract drift blocks settlement", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { store, provide } = yield* setup({
          tasksWorkerIngress: "INGRESS_TRAFFIC_ALL",
        });
        const exit = yield* provide(
          deliverRelease(
            sandboxConfig,
            { sha: shaA, imageDigest: digestA },
            policy
          ).pipe(Effect.exit)
        );
        return { exit, record: (yield* store.read).record };
      })
    );
    expect(errorOf(result.exit)).toMatchObject({
      _tag: "ReleaseServiceDrift",
      drift: [
        {
          workload: "tasks-worker",
          field: "ingress",
          observed: "INGRESS_TRAFFIC_ALL",
        },
      ],
    });
    expect(result.record.pendingApply).not.toBeNull();
  });
});
