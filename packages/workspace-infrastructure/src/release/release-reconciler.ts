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
 * Readback shows neither the intended target nor the release it replaced.
 * An operator reconciles it; the reconciler never guesses.
 */
export class UnknownReleaseApplyState extends Data.TaggedError(
  "UnknownReleaseApplyState"
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
 * Record a built image as a candidate. Its release ID and Cloud Run
 * revision name derive from the new generation, so reruns never collide.
 */
export const stage = Effect.fn("WorkspaceRelease.stage")(function* (
  record: ReleaseRecord,
  input: StageInput
) {
  yield* fence(record, input.expectedGeneration);
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
      staged: [...record.staged, deployment],
    } satisfies ReleaseRecord,
  };
});

export interface TrafficChangeInput {
  readonly expectedGeneration: number;
  readonly releaseId: ReleaseId;
  readonly now: DateTime.Utc;
}

/** Persist the intent to move traffic to a staged release. */
export const promote = Effect.fn("WorkspaceRelease.promote")(function* (
  record: ReleaseRecord,
  input: TrafficChangeInput
) {
  yield* fence(record, input.expectedGeneration);
  yield* requireNoPendingApply(record);
  const target = record.staged.find(
    (entry) => entry.releaseId === input.releaseId
  );
  if (target === undefined) {
    return yield* new ReleaseNotStaged({ releaseId: input.releaseId });
  }
  return {
    ...record,
    generation: record.generation + 1,
    pendingApply: {
      operation: "promote",
      target,
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
    pendingApply: {
      operation: "restore",
      target: deploymentOf(target),
      startedAt: isoOf(input.now),
    },
  } satisfies ReleaseRecord;
});

export interface SettleInput {
  readonly expectedGeneration: number;
  readonly readback: TrafficReadback;
  readonly now: DateTime.Utc;
}

const servesDeployment = (
  readback: TrafficReadback,
  deployment: ReleaseDeployment
) =>
  readback.servingRevision === deployment.revision &&
  readback.servingImageDigest === deployment.imageDigest;

/**
 * Settle the persisted traffic intent from readback. A normal apply and a
 * recovery after an unknown apply response take the same path: readback
 * showing the target completes it, readback showing the prior release
 * abandons it, and anything else fails for an operator.
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
  if (servesDeployment(input.readback, pending.target)) {
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
      active: verified,
      previous: record.active,
      staged: withoutRelease(record.staged, pending.target.releaseId),
      compatible: [
        ...(record.active === null
          ? keptCompatible
          : withoutRelease(keptCompatible, record.active.releaseId)),
        ...demoted,
      ],
      pendingApply: null,
    } satisfies ReleaseRecord;
  }
  if (
    record.active !== null &&
    servesDeployment(input.readback, record.active)
  ) {
    return {
      ...record,
      generation,
      pendingApply: null,
    } satisfies ReleaseRecord;
  }
  return yield* new UnknownReleaseApplyState({
    intended: pending.target.releaseId,
    servingRevision: input.readback.servingRevision,
  });
});

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
        Ref.get(state).pipe(
          Effect.flatMap((current) => {
            if (current.version !== ifVersion) {
              return Effect.fail(
                new ReleaseRecordConflict({ expectedVersion: ifVersion })
              );
            }
            const next: StoredReleaseRecord = {
              record,
              version: String(Number(current.version) + 1),
            };
            return Ref.set(state, next).pipe(Effect.as(next));
          })
        ),
    });
  });
