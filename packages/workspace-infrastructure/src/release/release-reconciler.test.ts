import { describe, expect, test } from "bun:test";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { ImageDigest } from "../config/stack-config";
import { webTraffic } from "../resources/service-declarations";
import {
  makeInMemoryReleaseRecordStore,
  promote,
  ReleaseRecordStore,
  restore,
  routableDeployments,
  runReleaseStep,
  settleApply,
  stage,
} from "./release-reconciler";
import {
  emptyReleaseRecord,
  GitSha,
  type ReleaseId,
  ReleaseRecord,
} from "./release-record";

const shaA = GitSha.make("a".repeat(40));
const shaB = GitSha.make("b".repeat(40));
const shaC = GitSha.make("c".repeat(40));
const digestA = ImageDigest.make(`sha256:${"1".repeat(64)}`);
const digestB = ImageDigest.make(`sha256:${"2".repeat(64)}`);
const digestC = ImageDigest.make(`sha256:${"3".repeat(64)}`);
const t0 = DateTime.makeUnsafe("2026-11-22T10:00:00Z");
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

/** Stage, promote and settle one release against readback that serves it. */
const release = (
  record: ReleaseRecord,
  sha: GitSha,
  digest: ImageDigest,
  now: DateTime.Utc
) => {
  const staged = run(
    stage(record, {
      expectedGeneration: record.generation,
      sha,
      imageDigest: digest,
      origin: "cloud-run",
    })
  );
  const pending = run(
    promote(staged.record, {
      expectedGeneration: staged.record.generation,
      releaseId: staged.releaseId,
      now,
    })
  );
  const target = pending.pendingApply?.target;
  return {
    releaseId: staged.releaseId,
    pending,
    settled: run(
      settleApply(pending, {
        expectedGeneration: pending.generation,
        readback: {
          servingRevision: target?.revision ?? null,
          servingImageDigest: target?.imageDigest ?? null,
        },
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
      staged: [],
      compatible: [],
      pendingApply: null,
    });
    expect(Schema.is(ReleaseRecord)(first.settled)).toBe(true);
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
          now: t0,
        })
      )
    ).toMatchObject({ _tag: "StaleReleaseGeneration" });
  });

  test("keeps the replaced release compatible for exactly 12 hours", () => {
    const first = release(emptyReleaseRecord, shaA, digestA, t0);
    const second = release(first.settled, shaB, digestB, later(1));
    expect(second.settled.previous?.releaseId).toBe(first.releaseId);
    expect(second.settled.compatible).toEqual(
      first.settled.active === null
        ? []
        : [{ ...first.settled.active, expiresAt: "2026-11-22T23:00:00.000Z" }]
    );
    expect(second.settled.compatible).toHaveLength(1);
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
    expect(webTraffic(second.settled, later(2))).toEqual([
      {
        type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION",
        revision: "workspace-web-r4-bbbbbbb",
        percent: 100,
        tag: "release-r4-bbbbbbb",
      },
      {
        type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION",
        revision: "workspace-web-r1-aaaaaaa",
        percent: 0,
        tag: "release-r1-aaaaaaa",
      },
    ]);
  });

  test("restores the previous release and moves the current one into the window", () => {
    const first = release(emptyReleaseRecord, shaA, digestA, t0);
    const second = release(first.settled, shaB, digestB, later(1));
    const pending = run(
      restore(second.settled, {
        expectedGeneration: second.settled.generation,
        releaseId: first.releaseId,
        now: later(2),
      })
    );
    expect(pending.pendingApply?.operation).toBe("restore");
    const restored = run(
      settleApply(pending, {
        expectedGeneration: pending.generation,
        readback: {
          servingRevision: "workspace-web-r1-aaaaaaa",
          servingImageDigest: digestA,
        },
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
    // r1 is no longer `previous`; only its compatible entry could allow it.
    expect(
      run(
        restore(third.settled, {
          expectedGeneration: third.settled.generation,
          releaseId: first.releaseId,
          now: later(12.5),
        })
      ).pendingApply?.target.releaseId
    ).toBe(first.releaseId);
    expect(
      failure(
        restore(third.settled, {
          expectedGeneration: third.settled.generation,
          releaseId: first.releaseId,
          now: later(13),
        })
      )
    ).toMatchObject({ _tag: "ReleaseNotRestorable" });
  });

  test("recovers an unknown apply response from readback", () => {
    const first = release(emptyReleaseRecord, shaA, digestA, t0);
    const staged = run(
      stage(first.settled, {
        expectedGeneration: first.settled.generation,
        sha: shaB,
        imageDigest: digestB,
        origin: "cloud-run",
      })
    );
    const pending = run(
      promote(staged.record, {
        expectedGeneration: staged.record.generation,
        releaseId: staged.releaseId,
        now: later(1),
      })
    );
    // A new operation waits until the pending apply is settled.
    expect(
      failure(
        promote(pending, {
          expectedGeneration: pending.generation,
          releaseId: staged.releaseId,
          now: later(1),
        })
      )
    ).toMatchObject({ _tag: "ReleaseApplyPending" });

    // The apply never landed: the old release still serves.
    const abandoned = run(
      settleApply(pending, {
        expectedGeneration: pending.generation,
        readback: {
          servingRevision: "workspace-web-r1-aaaaaaa",
          servingImageDigest: digestA,
        },
        now: later(1),
      })
    );
    expect(abandoned.active?.releaseId).toBe(first.releaseId);
    expect(abandoned.pendingApply).toBeNull();
    expect(abandoned.staged.map((entry) => entry.releaseId)).toEqual([
      staged.releaseId,
    ]);

    // Split, failed or foreign traffic needs an operator.
    for (const readback of [
      { servingRevision: null, servingImageDigest: null },
      {
        servingRevision: "workspace-web-r4-bbbbbbb",
        servingImageDigest: digestA,
      },
    ]) {
      expect(
        failure(
          settleApply(pending, {
            expectedGeneration: pending.generation,
            readback,
            now: later(1),
          })
        )
      ).toMatchObject({
        _tag: "UnknownReleaseApplyState",
        intended: staged.releaseId,
      });
    }
  });

  test("serializes steps: a run holding an old store version cannot write", () => {
    const result = Effect.runSync(
      Effect.gen(function* () {
        const store = yield* makeInMemoryReleaseRecordStore(emptyReleaseRecord);
        const before = yield* store.read;
        const staged = yield* runReleaseStep((record) =>
          stage(record, {
            expectedGeneration: record.generation,
            sha: shaA,
            imageDigest: digestA,
            origin: "cloud-run",
          }).pipe(
            Effect.map(({ record: next, releaseId }) => ({
              record: next,
              result: releaseId,
            }))
          )
        ).pipe(Effect.provideService(ReleaseRecordStore, store));
        const conflict = yield* Effect.flip(
          store.write(emptyReleaseRecord, before.version)
        );
        return { staged, conflict, after: yield* store.read };
      })
    );
    expect(result.staged).toBe("r1-aaaaaaa" as ReleaseId);
    expect(result.conflict._tag).toBe("ReleaseRecordConflict");
    expect(result.after.record.generation).toBe(1);
  });
});
