import { describe, expect, test } from "bun:test";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { ImageDigest } from "../config/stack-config";
import { sandboxConfig } from "../config/stack-config.test-utils";
import { webServiceProps, webTraffic } from "../resources/service-declarations";
import { workersServing } from "./release-readback.test-utils";
import {
  promote,
  refreshTemplate,
  restore,
  routableDeployments,
  settleApply,
  stage,
} from "./release-reconciler";
import {
  emptyReleaseRecord,
  GitSha,
  type MaterializedDeployment,
  type ReleaseId,
  ReleaseRecord,
  templateRevisionOf,
} from "./release-record";
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
const t0 = DateTime.makeUnsafe("2026-11-22T10:00:00Z");

/** Every image's template spec, as a config that never changes declares it. */
const specFingerprintOf = () => "spec-a";

/** The live template Cloud Run reports once a deployment's template landed. */
const templateOf = (deployment: MaterializedDeployment | null) =>
  deployment === null
    ? null
    : {
        revision: templateRevisionOf(deployment),
        imageDigest: deployment.imageDigest,
        specFingerprint: "spec-a",
        ready: true,
      };
const later = (hours: number) =>
  DateTime.addDuration(t0, Duration.hours(hours));

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSync(effect);
const failure = <A, E>(effect: Effect.Effect<A, E>) => {
  const exit = Effect.runSyncExit(effect);
  if (Exit.isSuccess(exit)) {
    throw new Error("expected a failure");
  }
  const reason = exit.cause.reasons[0];
  return reason?._tag === "Fail" ? reason.error : reason;
};

const stageRelease = (
  record: ReleaseRecord,
  sha: GitSha,
  digest: ImageDigest
) =>
  run(
    stage(record, {
      expectedGeneration: record.generation,
      sha,
      imageDigest: digest,
      origin: "cloud-run",
      liveTemplate: null,
      now: t0,
    })
  );

/** Stage, verify the candidate, promote and settle one release. */
const release = (
  record: ReleaseRecord,
  sha: GitSha,
  digest: ImageDigest,
  now: DateTime.Utc
) => {
  const staged = stageRelease(record, sha, digest);
  const candidate = staged.record.candidate;
  const pending = run(
    promote(staged.record, {
      expectedGeneration: staged.record.generation,
      releaseId: staged.releaseId,
      now,
      candidateReadback:
        candidate === null
          ? null
          : {
              revision: candidate.revision,
              imageDigest: candidate.imageDigest,
            },
    })
  );
  const target = pending.pendingApply?.target;
  return {
    releaseId: staged.releaseId,
    staged: staged.record,
    pending,
    settled: run(
      settleApply(pending, {
        expectedGeneration: pending.generation,
        readback: {
          servingRevision: target?.revision ?? null,
          servingImageDigest: target?.imageDigest ?? null,
          trafficGeneration: pending.pendingApply?.trafficGeneration ?? null,
        },
        workers: workersServing(target?.imageDigest ?? null),
        now,
      })
    ),
  };
};

describe("release reconciler", () => {
  test("stages, promotes and settles with an advancing generation", () => {
    const first = release(emptyReleaseRecord, shaA, digestA, t0);
    expect(first.releaseId).toBe("r1-aaaaaaa" as ReleaseId);
    expect(first.pending.generation).toBe(2);
    expect(first.pending.active).toBeNull();
    expect(first.settled).toMatchObject({
      generation: 3,
      active: {
        releaseId: first.releaseId,
        imageDigest: digestA,
        revision: "workspace-web-r1-aaaaaaa",
        verifiedAt: "2026-11-22T10:00:00.000Z",
      },
      previous: null,
      candidate: null,
      compatible: [],
      pendingApply: null,
    });
    expect(Schema.is(ReleaseRecord)(first.settled)).toBe(true);
  });

  test("declares no service before the first release serves", () => {
    const staged = stageRelease(emptyReleaseRecord, shaA, digestA);
    expect(webServiceProps(sandboxConfig, staged.record, t0)).toBeUndefined();
  });

  test("materializes a later candidate at zero traffic and promotes it only after readback", () => {
    const first = release(emptyReleaseRecord, shaA, digestA, t0);
    const staged = stageRelease(first.settled, shaB, digestB);
    const web = webServiceProps(sandboxConfig, staged.record, later(1));
    expect(web?.template?.revision).toBe("workspace-web-r4-bbbbbbb");
    expect(web?.traffic).toEqual([
      {
        type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION",
        revision: "workspace-web-r1-aaaaaaa",
        percent: 100,
        tag: "release-r1-aaaaaaa",
      },
      {
        type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION",
        revision: "workspace-web-r4-bbbbbbb",
        percent: 0,
        tag: "release-r4-bbbbbbb",
      },
    ]);
    for (const candidateReadback of [
      null,
      { revision: "workspace-web-r4-bbbbbbb", imageDigest: digestA },
      { revision: "workspace-web-r1-aaaaaaa", imageDigest: digestB },
    ]) {
      expect(
        failure(
          promote(staged.record, {
            expectedGeneration: staged.record.generation,
            releaseId: staged.releaseId,
            now: later(1),
            candidateReadback,
          })
        )
      ).toMatchObject({ _tag: "CandidateNotVerified" });
    }
  });

  test("refuses every operation from a stale generation", () => {
    const { settled } = release(emptyReleaseRecord, shaA, digestA, t0);
    expect(
      failure(
        stage(settled, {
          expectedGeneration: settled.generation - 1,
          sha: shaB,
          imageDigest: digestB,
          origin: "cloud-run",
          liveTemplate: null,
          now: t0,
        })
      )
    ).toMatchObject({
      _tag: "StaleReleaseGeneration",
      currentGeneration: settled.generation,
    });
    expect(
      failure(
        restore(settled, {
          expectedGeneration: 1,
          releaseId: "r1-aaaaaaa" as ReleaseId,
          liveTemplate: templateOf(settled.materialized),
          specFingerprintOf,
          now: t0,
        })
      )
    ).toMatchObject({ _tag: "StaleReleaseGeneration" });
  });

  test("keeps the replaced release compatible for exactly 12 hours", () => {
    const first = release(emptyReleaseRecord, shaA, digestA, t0);
    const second = release(first.settled, shaB, digestB, later(1));
    expect(second.settled.previous?.releaseId).toBe(first.releaseId);
    expect(second.settled.compatible).toHaveLength(1);
    expect(second.settled.compatible[0]).toMatchObject({
      releaseId: first.releaseId,
      expiresAt: "2026-11-22T23:00:00.000Z",
    });
    expect(
      routableDeployments(second.settled, later(12.9)).map(
        (entry) => entry.releaseId
      )
    ).toEqual([second.releaseId, first.releaseId]);
    expect(
      routableDeployments(second.settled, later(13)).map(
        (entry) => entry.releaseId
      )
    ).toEqual([second.releaseId]);
    expect(webTraffic(second.settled, later(13))).toHaveLength(1);
  });

  test("restores the previous release and moves the current one into the window", () => {
    const first = release(emptyReleaseRecord, shaA, digestA, t0);
    const second = release(first.settled, shaB, digestB, later(1));
    const pending = run(
      restore(second.settled, {
        expectedGeneration: second.settled.generation,
        releaseId: first.releaseId,
        liveTemplate: templateOf(second.settled.materialized),
        specFingerprintOf,
        now: later(2),
      })
    );
    expect(pending.pendingApply?.operation).toBe("restore");
    // Restore changes traffic only: the template stays the newest revision.
    const web = webServiceProps(sandboxConfig, pending, later(2));
    expect(web?.template?.revision).toBe("workspace-web-r4-bbbbbbb");
    expect(web?.traffic?.[0]).toMatchObject({
      revision: "workspace-web-r1-aaaaaaa",
      percent: 100,
    });
    expect(web?.annotations).toEqual({
      "deskohub.workspace/traffic-generation": String(
        pending.trafficGeneration
      ),
    });
    const restored = run(
      settleApply(pending, {
        expectedGeneration: pending.generation,
        readback: {
          servingRevision: "workspace-web-r1-aaaaaaa",
          servingImageDigest: digestA,
          trafficGeneration: pending.trafficGeneration,
        },
        workers: workersServing(digestA),
        now: later(2),
      })
    );
    expect(restored.active?.releaseId).toBe(first.releaseId);
    expect(restored.previous?.releaseId).toBe(second.releaseId);
    expect(restored.compatible.map((entry) => entry.releaseId)).toEqual([
      second.releaseId,
    ]);
  });

  test("refuses to restore a release whose window expired", () => {
    const first = release(emptyReleaseRecord, shaA, digestA, t0);
    const second = release(first.settled, shaB, digestB, later(1));
    const third = release(second.settled, shaC, digestC, later(2));
    expect(
      run(
        restore(third.settled, {
          expectedGeneration: third.settled.generation,
          releaseId: first.releaseId,
          liveTemplate: templateOf(third.settled.materialized),
          specFingerprintOf,
          now: later(12.5),
        })
      ).pendingApply?.target.releaseId
    ).toBe(first.releaseId);
    expect(
      failure(
        restore(third.settled, {
          expectedGeneration: third.settled.generation,
          releaseId: first.releaseId,
          liveTemplate: templateOf(third.settled.materialized),
          specFingerprintOf,
          now: later(13),
        })
      )
    ).toMatchObject({ _tag: "ReleaseNotRestorable" });
  });

  test("keeps an unknown apply pending until readback shows the target", () => {
    const first = release(emptyReleaseRecord, shaA, digestA, t0);
    const staged = stageRelease(first.settled, shaB, digestB);
    const pending = run(
      promote(staged.record, {
        expectedGeneration: staged.record.generation,
        releaseId: staged.releaseId,
        now: later(1),
        candidateReadback: {
          revision: "workspace-web-r4-bbbbbbb",
          imageDigest: digestB,
        },
      })
    );
    // While an apply is pending, nothing else may start.
    const blockedSteps: ReadonlyArray<Effect.Effect<unknown, unknown>> = [
      promote(pending, {
        expectedGeneration: pending.generation,
        releaseId: staged.releaseId,
        now: later(1),
        candidateReadback: null,
      }),
      stage(pending, {
        expectedGeneration: pending.generation,
        sha: shaC,
        imageDigest: digestC,
        origin: "cloud-run",
        liveTemplate: null,
        now: t0,
      }),
    ];
    for (const blocked of blockedSteps) {
      expect(failure(blocked)).toMatchObject({
        _tag: "ReleaseApplyPending",
      });
    }
    // The old release still serving, split traffic or a foreign digest all
    // leave the intent pending: the interrupted request may still land.
    for (const readback of [
      {
        servingRevision: "workspace-web-r1-aaaaaaa",
        servingImageDigest: digestA,
        trafficGeneration: pending.trafficGeneration - 1,
      },
      {
        servingRevision: null,
        servingImageDigest: null,
        trafficGeneration: null,
      },
      // The target serves, but stamped by an older run's delayed write.
      {
        servingRevision: "workspace-web-r4-bbbbbbb",
        servingImageDigest: digestB,
        trafficGeneration: pending.trafficGeneration - 1,
      },
      {
        servingRevision: "workspace-web-r4-bbbbbbb",
        servingImageDigest: digestA,
        trafficGeneration: pending.trafficGeneration,
      },
    ]) {
      expect(
        failure(
          settleApply(pending, {
            expectedGeneration: pending.generation,
            readback,
            workers: workersServing(readback.servingImageDigest),
            now: later(1),
          })
        )
      ).toMatchObject({
        _tag: "ReleaseApplyNotObserved",
        intended: staged.releaseId,
      });
    }
    // Recovery is re-applying the same declaration until readback shows it.
    expect(
      run(
        settleApply(pending, {
          expectedGeneration: pending.generation,
          readback: {
            servingRevision: "workspace-web-r4-bbbbbbb",
            servingImageDigest: digestB,
            trafficGeneration: pending.trafficGeneration,
          },
          workers: workersServing(digestB),
          now: later(1.5),
        })
      ).active?.releaseId
    ).toBe(staged.releaseId);
  });

  test("serializes concurrent steps: only one writer per store version wins", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* makeInMemoryReleaseRecordStore(emptyReleaseRecord);
        const step = (sha: GitSha) =>
          runReleaseStep((record) =>
            // Yield after the read so both runs hold the same version.
            Effect.andThen(
              Effect.yieldNow,
              stage(record, {
                expectedGeneration: record.generation,
                sha,
                imageDigest: digestA,
                origin: "cloud-run",
                liveTemplate: null,
                now: t0,
              })
            ).pipe(
              Effect.map(({ record: next, releaseId }) => ({
                record: next,
                result: releaseId,
              }))
            )
          ).pipe(
            Effect.provideService(ReleaseRecordStore, store),
            Effect.result
          );
        const outcomes = yield* Effect.all([step(shaA), step(shaB)], {
          concurrency: "unbounded",
        });
        return { outcomes, after: yield* store.read };
      })
    );
    expect(result.outcomes.map((outcome) => outcome._tag).toSorted()).toEqual([
      "Failure",
      "Success",
    ]);
    expect(result.after.record.generation).toBe(1);
    expect(result.after.version).toBe("2");
  });
});

describe("declared web template", () => {
  /** r1 active and r4 serving, so r1 is the previous release. */
  const twoReleases = (): ReleaseRecord => {
    const first = release(emptyReleaseRecord, shaA, digestA, t0);
    return release(first.settled, shaB, digestB, later(1)).settled;
  };
  const restoreFirst = (
    record: ReleaseRecord,
    liveTemplate: ReturnType<typeof templateOf>,
    fingerprint = specFingerprintOf
  ): ReleaseRecord =>
    run(
      restore(record, {
        expectedGeneration: record.generation,
        releaseId: "r1-aaaaaaa" as ReleaseId,
        now: later(2),
        liveTemplate,
        specFingerprintOf: fingerprint,
      })
    );
  const settleRestore = (pending: ReleaseRecord) => {
    const target = pending.pendingApply?.target;
    return run(
      settleApply(pending, {
        expectedGeneration: pending.generation,
        readback: {
          servingRevision: target?.revision ?? null,
          servingImageDigest: target?.imageDigest ?? null,
          trafficGeneration: pending.pendingApply?.trafficGeneration ?? null,
        },
        workers: workersServing(target?.imageDigest ?? null),
        now: later(2),
      })
    );
  };

  test("restore keeps a ready template declared from the current spec", () => {
    const settled = twoReleases();
    const pending = restoreFirst(settled, templateOf(settled.materialized));
    expect(pending.materialized).toEqual(settled.materialized);
  });

  test("restore over a failed template mints a fresh name and settles", () => {
    const settled = twoReleases();
    const failed = templateOf(settled.materialized);
    const pending = restoreFirst(
      settled,
      failed === null ? null : { ...failed, ready: false }
    );
    expect(pending.materialized).toMatchObject({
      releaseId: "r1-aaaaaaa",
      imageDigest: digestA,
      template: {
        revision: `workspace-web-r1-aaaaaaa-t${pending.generation}`,
        specFingerprint: "spec-a",
      },
    });
    const restored = settleRestore(pending);
    expect(restored.active?.releaseId).toBe("r1-aaaaaaa" as ReleaseId);
    expect(restored.materialized).toEqual(pending.materialized);
    // Traffic still targets the release's own revision.
    expect(restored.active?.revision).toBe("workspace-web-r1-aaaaaaa");
    const web = webServiceProps(sandboxConfig, restored, later(2));
    expect(web?.template?.revision).toBe(
      `workspace-web-r1-aaaaaaa-t${pending.generation}`
    );
    expect(web?.traffic?.[0]?.revision).toBe("workspace-web-r1-aaaaaaa");
  });

  test("restore over a template from an older spec mints a fresh name", () => {
    const settled = twoReleases();
    const pending = restoreFirst(
      settled,
      templateOf(settled.materialized),
      () => "spec-b"
    );
    expect(pending.materialized?.template).toEqual({
      revision: `workspace-web-r1-aaaaaaa-t${pending.generation}`,
      specFingerprint: "spec-b",
    });
  });

  test("a minted name that has not landed is reused on the next decision", () => {
    const settled = twoReleases();
    const oldTemplate = templateOf(settled.materialized);
    const changed = () => "spec-b";
    const first = run(
      refreshTemplate(settled, {
        expectedGeneration: settled.generation,
        liveTemplate: oldTemplate,
        specFingerprintOf: changed,
      })
    );
    const minted = first.materialized?.template;
    expect(minted?.revision).toBe(
      `workspace-web-r4-bbbbbbb-t${first.generation}`
    );
    // The deploy failed before the template landed: the retry reuses it.
    const retried = run(
      refreshTemplate(first, {
        expectedGeneration: first.generation,
        liveTemplate: oldTemplate,
        specFingerprintOf: changed,
      })
    );
    expect(retried.materialized?.template).toEqual(minted);
  });

  test("a plain deploy after a config change mints a name once", () => {
    const settled = twoReleases();
    const changed = () => "spec-b";
    const unchanged = run(
      refreshTemplate(settled, {
        expectedGeneration: settled.generation,
        liveTemplate: templateOf(settled.materialized),
        specFingerprintOf,
      })
    );
    expect(unchanged).toEqual(settled);
    const minted = run(
      refreshTemplate(settled, {
        expectedGeneration: settled.generation,
        liveTemplate: templateOf(settled.materialized),
        specFingerprintOf: changed,
      })
    );
    const landed = templateOf(minted.materialized);
    const again = run(
      refreshTemplate(minted, {
        expectedGeneration: minted.generation,
        liveTemplate:
          landed === null ? null : { ...landed, specFingerprint: "spec-b" },
        specFingerprintOf: changed,
      })
    );
    expect(again).toEqual(minted);
    expect(minted.materialized?.template?.revision).toBe(
      `workspace-web-r4-bbbbbbb-t${minted.generation}`
    );
  });

  test("a plain deploy drops a landed candidate from an older spec", () => {
    const settled = twoReleases();
    const staged = stageRelease(settled, shaC, digestC).record;
    const refreshed = run(
      refreshTemplate(staged, {
        expectedGeneration: staged.generation,
        liveTemplate: templateOf(staged.candidate),
        specFingerprintOf: () => "spec-b",
      })
    );
    expect(refreshed.candidate).toBeNull();
    expect(refreshed.materialized?.releaseId).toBe("r4-bbbbbbb" as ReleaseId);
    // An unlanded candidate is created from the current spec instead,
    // whether or not the spec changed.
    for (const fingerprint of [specFingerprintOf, () => "spec-b"]) {
      expect(
        run(
          refreshTemplate(staged, {
            expectedGeneration: staged.generation,
            liveTemplate: templateOf(staged.materialized),
            specFingerprintOf: fingerprint,
          })
        )
      ).toEqual(staged);
    }
  });

  test("restaging an unsettled first release keeps its landed template", () => {
    const staged = stageRelease(emptyReleaseRecord, shaA, digestA);
    const pending = run(
      promote(staged.record, {
        expectedGeneration: staged.record.generation,
        releaseId: staged.releaseId,
        now: t0,
        candidateReadback: null,
      })
    );
    const restaged = run(
      stage(pending, {
        expectedGeneration: pending.generation,
        sha: shaB,
        imageDigest: digestB,
        origin: "cloud-run",
        liveTemplate: templateOf(pending.candidate),
        now: t0,
      })
    );
    expect(restaged.promoted).toBe(true);
    expect(restaged.record.materialized?.releaseId).toBe(staged.releaseId);
    expect(restaged.record.pendingApply?.target.releaseId).toBe(
      restaged.releaseId
    );
  });
});
