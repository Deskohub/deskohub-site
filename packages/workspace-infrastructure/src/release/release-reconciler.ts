import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type { ImageDigest } from "../config/stack-config";
import { workspaceWebServiceId } from "../resources/workload-names";
import {
  type CompatibleDeployment,
  compatibleDeploymentWindowHours,
  type GitSha,
  type ReleaseDeployment,
  ReleaseId,
  type ReleaseOrigin,
  type ReleaseRecord,
  type VerifiedDeployment,
} from "./release-record";

export class StaleReleaseGeneration extends Data.TaggedError(
  "StaleReleaseGeneration"
)<{
  readonly expectedGeneration: number;
  readonly currentGeneration: number;
}> {}

export class ReleaseApplyPending extends Data.TaggedError(
  "ReleaseApplyPending"
)<{
  readonly releaseId: ReleaseId;
}> {}

/** The candidate revision's readback does not match the staged release. */
export class CandidateNotVerified extends Data.TaggedError(
  "CandidateNotVerified"
)<{
  readonly releaseId: ReleaseId;
}> {}

export class NoPendingReleaseApply extends Data.TaggedError(
  "NoPendingReleaseApply"
) {}

export class ReleaseNotStaged extends Data.TaggedError("ReleaseNotStaged")<{
  readonly releaseId: ReleaseId;
}> {}

/** Restore accepts only the previous release or an unexpired compatible one. */
export class ReleaseNotRestorable extends Data.TaggedError(
  "ReleaseNotRestorable"
)<{
  readonly releaseId: ReleaseId;
}> {}

/**
 * Readback does not show the intended target serving. The intent stays
 * pending: the caller re-applies the same declaration (apply is
 * idempotent) and settles again, or an operator abandons it with evidence.
 */
export class ReleaseApplyNotObserved extends Data.TaggedError(
  "ReleaseApplyNotObserved"
)<{
  readonly intended: ReleaseId;
  readonly servingRevision: string | null;
}> {}

export class ReleaseRecordConflict extends Data.TaggedError(
  "ReleaseRecordConflict"
)<{
  readonly expectedVersion: string;
}> {}

/** What the platform actually serves, read back after an apply. */
export interface TrafficReadback {
  /** Revision taking 100% of untagged traffic, or null when split/unknown. */
  readonly servingRevision: string | null;
  readonly servingImageDigest: ImageDigest | null;
  /** The traffic generation stamped on the service, or null when absent. */
  readonly trafficGeneration: number | null;
}

const fence = (record: ReleaseRecord, expectedGeneration: number) =>
  record.generation === expectedGeneration
    ? Effect.void
    : Effect.fail(
        new StaleReleaseGeneration({
          expectedGeneration,
          currentGeneration: record.generation,
        })
      );

const requireNoPendingApply = (record: ReleaseRecord) =>
  record.pendingApply === null
    ? Effect.void
    : Effect.fail(
        new ReleaseApplyPending({
          releaseId: record.pendingApply.target.releaseId,
        })
      );

const isoOf = (now: DateTime.Utc) => DateTime.formatIso(now);

const unexpired = (
  compatible: ReadonlyArray<CompatibleDeployment>,
  now: DateTime.Utc
) =>
  compatible.filter((entry) =>
    DateTime.isGreaterThan(DateTime.makeUnsafe(entry.expiresAt), now)
  );

const withoutRelease = <A extends { readonly releaseId: ReleaseId }>(
  entries: ReadonlyArray<A>,
  releaseId: ReleaseId
) => entries.filter((entry) => entry.releaseId !== releaseId);

const deploymentOf = ({
  releaseId,
  sha,
  imageDigest,
  origin,
  revision,
}: ReleaseDeployment): ReleaseDeployment => ({
  releaseId,
  sha,
  imageDigest,
  origin,
  revision,
});

export interface StageInput {
  readonly expectedGeneration: number;
  readonly sha: GitSha;
  readonly imageDigest: ImageDigest;
  readonly origin: ReleaseOrigin;
}

/**
 * Record a built image as the candidate, replacing any earlier one. Its
 * release ID and Cloud Run revision name derive from the new generation, so
 * reruns never collide.
 */
export const stage = Effect.fn("WorkspaceRelease.stage")(function* (
  record: ReleaseRecord,
  input: StageInput
) {
  yield* fence(record, input.expectedGeneration);
  yield* requireNoPendingApply(record);
  const generation = record.generation + 1;
  const releaseId = ReleaseId.make(`r${generation}-${input.sha.slice(0, 7)}`);
  const deployment: ReleaseDeployment = {
    releaseId,
    sha: input.sha,
    imageDigest: input.imageDigest,
    origin: input.origin,
    revision: `${workspaceWebServiceId}-${releaseId}`,
  };
  return {
    releaseId,
    record: {
      ...record,
      generation,
      candidate: deployment,
    } satisfies ReleaseRecord,
  };
});

export interface TrafficChangeInput {
  readonly expectedGeneration: number;
  readonly releaseId: ReleaseId;
  readonly now: DateTime.Utc;
}

export interface PromoteInput extends TrafficChangeInput {
  /**
   * Readback of the zero-traffic candidate revision. Required once a
   * release is active; the very first release has no traffic to protect
   * and no candidate revision before its promotion.
   */
  readonly candidateReadback: {
    readonly revision: string;
    readonly imageDigest: ImageDigest | null;
  } | null;
}

/** Persist the intent to move traffic to the verified candidate. */
export const promote = Effect.fn("WorkspaceRelease.promote")(function* (
  record: ReleaseRecord,
  input: PromoteInput
) {
  yield* fence(record, input.expectedGeneration);
  yield* requireNoPendingApply(record);
  const target = record.candidate;
  if (target === null || target.releaseId !== input.releaseId) {
    return yield* new ReleaseNotStaged({ releaseId: input.releaseId });
  }
  const verified =
    input.candidateReadback !== null &&
    input.candidateReadback.revision === target.revision &&
    input.candidateReadback.imageDigest === target.imageDigest;
  if (record.active !== null && !verified) {
    return yield* new CandidateNotVerified({ releaseId: input.releaseId });
  }
  return {
    ...record,
    generation: record.generation + 1,
    trafficGeneration: record.trafficGeneration + 1,
    pendingApply: {
      operation: "promote",
      target,
      trafficGeneration: record.trafficGeneration + 1,
      startedAt: isoOf(input.now),
    },
  } satisfies ReleaseRecord;
});

/**
 * Persist the intent to move traffic back to the previous verified release
 * or a deployment still inside its compatible window.
 */
export const restore = Effect.fn("WorkspaceRelease.restore")(function* (
  record: ReleaseRecord,
  input: TrafficChangeInput
) {
  yield* fence(record, input.expectedGeneration);
  yield* requireNoPendingApply(record);
  const candidates: ReadonlyArray<VerifiedDeployment> = [
    ...(record.previous === null ? [] : [record.previous]),
    ...unexpired(record.compatible, input.now),
  ];
  const target = candidates.find(
    (entry) => entry.releaseId === input.releaseId
  );
  if (target === undefined || target.releaseId === record.active?.releaseId) {
    return yield* new ReleaseNotRestorable({ releaseId: input.releaseId });
  }
  return {
    ...record,
    generation: record.generation + 1,
    trafficGeneration: record.trafficGeneration + 1,
    pendingApply: {
      operation: "restore",
      target: deploymentOf(target),
      trafficGeneration: record.trafficGeneration + 1,
      startedAt: isoOf(input.now),
    },
  } satisfies ReleaseRecord;
});

export interface SettleInput {
  readonly expectedGeneration: number;
  readonly readback: TrafficReadback;
  readonly now: DateTime.Utc;
}

const servesPendingApply = (
  readback: TrafficReadback,
  pending: NonNullable<ReleaseRecord["pendingApply"]>
) =>
  readback.servingRevision === pending.target.revision &&
  readback.servingImageDigest === pending.target.imageDigest &&
  readback.trafficGeneration === pending.trafficGeneration;

/**
 * Settle the persisted traffic intent from readback. A normal apply and a
 * recovery after an unknown apply response take the same path: only
 * readback showing the target serving completes it. Anything else keeps
 * the intent pending, because an interrupted request may still land.
 */
export const settleApply = Effect.fn("WorkspaceRelease.settleApply")(function* (
  record: ReleaseRecord,
  input: SettleInput
) {
  yield* fence(record, input.expectedGeneration);
  const pending = record.pendingApply;
  if (pending === null) {
    return yield* new NoPendingReleaseApply();
  }
  const generation = record.generation + 1;
  if (servesPendingApply(input.readback, pending)) {
    const verified: VerifiedDeployment = {
      ...pending.target,
      verifiedAt: isoOf(input.now),
    };
    const demoted: ReadonlyArray<CompatibleDeployment> =
      record.active === null
        ? []
        : [
            {
              ...record.active,
              expiresAt: isoOf(
                DateTime.addDuration(
                  input.now,
                  Duration.hours(compatibleDeploymentWindowHours)
                )
              ),
            },
          ];
    const keptCompatible = withoutRelease(
      unexpired(record.compatible, input.now),
      pending.target.releaseId
    );
    return {
      generation,
      trafficGeneration: record.trafficGeneration,
      // The first release creates the template; later ones were candidates.
      materialized:
        record.materialized === null ||
        record.candidate?.releaseId === pending.target.releaseId
          ? pending.target
          : record.materialized,
      active: verified,
      previous: record.active,
      candidate:
        record.candidate?.releaseId === pending.target.releaseId
          ? null
          : record.candidate,
      compatible: [
        ...(record.active === null
          ? keptCompatible
          : withoutRelease(keptCompatible, record.active.releaseId)),
        ...demoted,
      ],
      pendingApply: null,
    } satisfies ReleaseRecord;
  }
  return yield* new ReleaseApplyNotObserved({
    intended: pending.target.releaseId,
    servingRevision: input.readback.servingRevision,
  });
});

export interface AbandonInput {
  readonly expectedGeneration: number;
  /** The operator's evidence that the interrupted apply can no longer land. */
  readonly evidence: string;
}

/**
 * Drop a pending traffic intent. Only an operator does this, with evidence
 * that the interrupted request can no longer take effect (its operation
 * finished, or a later service generation superseded it); readback showing
 * the old revision alone is not that evidence.
 */
export const abandonApply = Effect.fn("WorkspaceRelease.abandonApply")(
  function* (record: ReleaseRecord, input: AbandonInput) {
    yield* fence(record, input.expectedGeneration);
    if (record.pendingApply === null) {
      return yield* new NoPendingReleaseApply();
    }
    return {
      ...record,
      generation: record.generation + 1,
      pendingApply: null,
    } satisfies ReleaseRecord;
  }
);

/** Revisions the edge may route to now: serving, pending and compatible. */
export const routableDeployments = (
  record: ReleaseRecord,
  now: DateTime.Utc
): ReadonlyArray<ReleaseDeployment> => {
  const entries: ReadonlyArray<ReleaseDeployment> = [
    ...(record.pendingApply === null ? [] : [record.pendingApply.target]),
    ...(record.active === null ? [] : [record.active]),
    ...unexpired(record.compatible, now),
  ];
  return entries
    .filter(
      (entry, index) =>
        entries.findIndex((other) => other.releaseId === entry.releaseId) ===
        index
    )
    .map(deploymentOf);
};

/**
 * The persisted record behind a compare-and-set. `version` is the store's
 * object generation; a write with a stale version fails.
 */
export interface StoredReleaseRecord {
  readonly record: ReleaseRecord;
  readonly version: string;
}

export class ReleaseRecordStore extends Context.Service<
  ReleaseRecordStore,
  {
    readonly read: Effect.Effect<StoredReleaseRecord>;
    readonly write: (
      record: ReleaseRecord,
      ifVersion: string
    ) => Effect.Effect<StoredReleaseRecord, ReleaseRecordConflict>;
  }
>()("@deskohub/workspace-infrastructure/ReleaseRecordStore") {}

/**
 * Run one release step as a serialized read, decide, compare-and-set.
 * Two runs that read the same version cannot both write.
 */
export const runReleaseStep = <A, E>(
  step: (
    record: ReleaseRecord
  ) => Effect.Effect<{ readonly record: ReleaseRecord; readonly result: A }, E>
) =>
  Effect.gen(function* () {
    const store = yield* ReleaseRecordStore;
    const current = yield* store.read;
    const { record, result } = yield* step(current.record);
    yield* store.write(record, current.version);
    return result;
  });

/** An in-process store for tests and local dry runs. */
export const makeInMemoryReleaseRecordStore = (initial: ReleaseRecord) =>
  Effect.gen(function* () {
    const state = yield* Ref.make<StoredReleaseRecord>({
      record: initial,
      version: "1",
    });
    return ReleaseRecordStore.of({
      read: Ref.get(state),
      write: (record, ifVersion) =>
        Ref.modify(
          state,
          (
            current
          ): readonly [
            Effect.Effect<StoredReleaseRecord, ReleaseRecordConflict>,
            StoredReleaseRecord,
          ] => {
            if (current.version !== ifVersion) {
              return [
                Effect.fail(
                  new ReleaseRecordConflict({ expectedVersion: ifVersion })
                ),
                current,
              ];
            }
            const next: StoredReleaseRecord = {
              record,
              version: String(Number(current.version) + 1),
            };
            return [Effect.succeed(next), next];
          }
        ).pipe(Effect.flatten),
    });
  });
