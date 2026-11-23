import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
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
 * Readback does not show the intended target serving on the web service
 * and its image on every worker. The intent stays
 * pending and blocks every other release step: the caller re-applies the
 * same declaration (apply is idempotent) and settles again. There is no
 * abandon step until Cloud Run operation evidence can prove an interrupted
 * write can no longer land.
 */
export class ReleaseApplyNotObserved extends Data.TaggedError(
  "ReleaseApplyNotObserved"
)<{
  readonly intended: ReleaseId;
  readonly servingRevision: string | null;
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
 * The web service's live revision template is neither the revision the
 * record materialized nor its candidate. Declaring the record's template
 * would re-declare an older, immutable revision name with a different spec,
 * so nothing is changed until an operator reconciles the service.
 */
export class ReleaseTemplateUnknown extends Data.TaggedError(
  "ReleaseTemplateUnknown"
)<{
  readonly liveTemplateRevision: string | null;
  readonly expectedRevisions: ReadonlyArray<string>;
}> {}

export interface RestoreInput extends TrafficChangeInput {
  /** The revision the live web service template names, if it exists. */
  readonly liveTemplateRevision: string | null;
}

/**
 * The template the web service keeps once restore drops the candidate: the
 * candidate itself if its template already landed, else the materialized
 * one. Either way it must be the revision Cloud Run's template names now.
 */
const restoredTemplate = (record: ReleaseRecord, input: RestoreInput) => {
  const landed = [record.candidate, record.materialized].find(
    (deployment) =>
      deployment !== null && deployment.revision === input.liveTemplateRevision
  );
  return landed === undefined || landed === null
    ? Effect.fail(
        new ReleaseTemplateUnknown({
          liveTemplateRevision: input.liveTemplateRevision,
          expectedRevisions: [record.candidate, record.materialized].flatMap(
            (deployment) => (deployment === null ? [] : [deployment.revision])
          ),
        })
      )
    : Effect.succeed(deploymentOf(landed));
};

/**
 * Persist the intent to move traffic back to the previous verified release
 * or a deployment still inside its compatible window. An unverified
 * candidate is dropped, so it loses its traffic tag; the service template
 * stays the revision Cloud Run already runs.
 */
export const restore = Effect.fn("WorkspaceRelease.restore")(function* (
  record: ReleaseRecord,
  input: RestoreInput
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
  const materialized = yield* restoredTemplate(record, input);
  return {
    ...record,
    materialized,
    candidate: null,
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
  /** The web service's traffic. */
  readonly readback: TrafficReadback;
  /** Each worker's traffic; workers run the serving release's image. */
  readonly workers: ReadonlyArray<TrafficReadback>;
  readonly now: DateTime.Utc;
}

const servesPendingApply = (
  input: SettleInput,
  pending: NonNullable<ReleaseRecord["pendingApply"]>
) =>
  input.readback.servingRevision === pending.target.revision &&
  input.readback.servingImageDigest === pending.target.imageDigest &&
  input.readback.trafficGeneration === pending.trafficGeneration &&
  input.workers.every(
    (worker) => worker.servingImageDigest === pending.target.imageDigest
  );

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
  if (servesPendingApply(input, pending)) {
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
