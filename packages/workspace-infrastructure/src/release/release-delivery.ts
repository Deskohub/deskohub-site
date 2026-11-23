import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type {
  ImageDigest,
  WorkspaceStackConfig,
  WorkspaceWorkload,
} from "../config/stack-config";
import {
  liveTemplateOf,
  type ObservedService,
  type ReadbackDrift,
  serviceReadbackDrift,
  trafficReadback,
} from "../readback";
import { releaseTrafficTag } from "../resources/service-declarations";
import {
  observeReleaseServices,
  requireRecordCoversLiveService,
} from "./live-release-services";
import { ReleaseServiceReadback } from "./release-platform";
import {
  CandidateNotVerified,
  promote,
  ReleaseApplyPending,
  type ReleaseWorker,
  restore,
  type StageInput,
  StaleReleaseGeneration,
  settleApply,
  stage,
  type TrafficReadback,
} from "./release-reconciler";
import type {
  GitSha,
  ReleaseDeployment,
  ReleaseId,
  ReleaseOperation,
  ReleaseRecord,
  VerifiedDeployment,
} from "./release-record";
import { ReleaseRecordStore } from "./release-record-store";
import {
  applyAsWriter,
  runLockedReleaseStep,
  withReleaseWriter,
} from "./release-writer";

/**
 * A release-owned service no longer matches its fixed contract (ingress,
 * invoker IAM, worker URL). Traffic is not settled over it.
 */
export class ReleaseServiceDrift extends Data.TaggedError(
  "ReleaseServiceDrift"
)<{
  readonly drift: ReadonlyArray<ReadbackDrift>;
}> {}

/**
 * How long readback may lag an apply: Cloud Run reports a new revision's
 * readiness and traffic only after its rollout finishes.
 */
export interface ReleaseReadbackPolicy {
  readonly attempts: number;
  readonly spacing: Duration.Duration;
}

export const defaultReleaseReadbackPolicy: ReleaseReadbackPolicy = {
  attempts: 30,
  spacing: Duration.seconds(10),
};

const retryWhile = <E extends { readonly _tag: string }>(
  policy: ReleaseReadbackPolicy,
  tag: E["_tag"]
) => ({
  while: (error: E) => error._tag === tag,
  times: Math.max(0, policy.attempts - 1),
  schedule: Schedule.spaced(policy.spacing),
});

/** The release now serving all untagged traffic. */
export interface ServingRelease {
  readonly releaseId: ReleaseId;
  readonly generation: number;
  readonly revision: string;
  readonly imageDigest: ImageDigest;
}

const servingReleaseOf = (record: ReleaseRecord): ServingRelease | null =>
  record.active === null
    ? null
    : {
        releaseId: record.active.releaseId,
        generation: record.generation,
        revision: record.active.revision,
        imageDigest: record.active.imageDigest,
      };

/**
 * The record the service apply declares from, read under its generation
 * fence. A run that staged or promoted at one generation can never apply a
 * record another run has since moved on.
 *
 * The fence alone does not stop an older apply from landing late: a Cloud
 * Run write carries no etag, so a request accepted after a newer decision
 * (a lost response, a frozen process) still changes the service. The
 * writer lock closes that window except when an operator runs `unlock`
 * while the old executor is in fact still alive; no check after the apply
 * can prevent it. Hosted runs therefore use one non-cancelling concurrency
 * group per stage.
 */
export const readFencedReleaseRecord = (expectedGeneration: number) =>
  Effect.gen(function* () {
    const store = yield* ReleaseRecordStore;
    const { record } = yield* store.read;
    if (record.generation !== expectedGeneration) {
      return yield* new StaleReleaseGeneration({
        expectedGeneration,
        currentGeneration: record.generation,
      });
    }
    return record;
  });

const unavailableTraffic: TrafficReadback = {
  servingRevision: null,
  servingImageDigest: null,
  trafficGeneration: null,
};

/**
 * A service's drift from its fixed contract. A service that does not exist
 * yet has no contract to drift from: traffic readback reports it as not
 * serving, so settlement retries until the apply's rollout shows it.
 */
const contractDrift = (
  config: WorkspaceStackConfig,
  service: ObservedService | null
): ReadonlyArray<ReadbackDrift> =>
  service === null ? [] : serviceReadbackDrift(config, service);

/**
 * Read every release-owned service back and settle the pending traffic
 * change from what the web service actually serves. Contract drift fails
 * before the record changes.
 */
const settleFromReadback = (
  config: WorkspaceStackConfig,
  expectedGeneration: number
) =>
  Effect.gen(function* () {
    const observed = yield* observeReleaseServices;
    const drift = observed.flatMap(({ service }) =>
      contractDrift(config, service)
    );
    if (drift.length > 0) {
      return yield* new ReleaseServiceDrift({ drift });
    }
    const readbackOf = (workload: WorkspaceWorkload) => {
      const service =
        observed.find((entry) => entry.workload === workload)?.service ?? null;
      return service === null ? unavailableTraffic : trafficReadback(service);
    };
    const workers: Record<ReleaseWorker, TrafficReadback> = {
      "tasks-worker": readbackOf("tasks-worker"),
      "scheduler-worker": readbackOf("scheduler-worker"),
    };
    const now = yield* DateTime.now;
    return yield* runLockedReleaseStep((record) =>
      settleApply(record, {
        expectedGeneration,
        readback: readbackOf("web"),
        workers,
        now,
      }).pipe(Effect.map((next) => ({ record: next, result: next })))
    );
  });

/**
 * Apply the record persisted at `generation`, then settle its pending
 * traffic change once readback shows the target serving. Readback that
 * never converges leaves the intent pending for `recoverRelease`.
 */
const applyAndSettle = (
  config: WorkspaceStackConfig,
  generation: number,
  policy: ReleaseReadbackPolicy
) =>
  Effect.gen(function* () {
    yield* applyAsWriter({ action: "deploy", generation });
    const settled = yield* settleFromReadback(config, generation).pipe(
      Effect.retry(retryWhile(policy, "ReleaseApplyNotObserved"))
    );
    const serving = servingReleaseOf(settled);
    if (serving === null) {
      return yield* Effect.die(
        "A settled release record has no active release"
      );
    }
    return serving;
  });

/**
 * The web service still sends all traffic to the active release, and the
 * candidate is reachable only through its zero-percent tag.
 */
const holdsCandidateAtZero = (
  web: ObservedService | null,
  active: VerifiedDeployment,
  candidate: ReleaseDeployment
) => {
  if (web === null) {
    return false;
  }
  const serving = trafficReadback(web);
  return (
    serving.servingRevision === active.revision &&
    serving.servingImageDigest === active.imageDigest &&
    web.traffic.some(
      (entry) =>
        entry.revision === candidate.revision &&
        entry.percent === 0 &&
        entry.tag === releaseTrafficTag(candidate.releaseId)
    )
  );
};

/**
 * Wait until the staged candidate revision is ready, read its digest, and
 * confirm the active release still serves everything while the candidate
 * holds no traffic.
 */
const observeCandidate = (
  candidate: ReleaseDeployment,
  active: VerifiedDeployment,
  policy: ReleaseReadbackPolicy
) =>
  Effect.gen(function* () {
    const readback = yield* ReleaseServiceReadback;
    const observed = yield* readback.revision(candidate.revision);
    const web = yield* readback.service("web");
    if (
      observed === null ||
      !observed.ready ||
      !holdsCandidateAtZero(web, active, candidate)
    ) {
      return yield* new CandidateNotVerified({
        releaseId: candidate.releaseId,
      });
    }
    return { revision: observed.revision, imageDigest: observed.imageDigest };
  }).pipe(Effect.retry(retryWhile(policy, "CandidateNotVerified")));

export interface DeliverReleaseInput {
  readonly sha: GitSha;
  readonly imageDigest: ImageDigest;
}

/** The web service's live template as Cloud Run reports it now. */
const readLiveTemplate = Effect.gen(function* () {
  const readback = yield* ReleaseServiceReadback;
  return liveTemplateOf(yield* readback.service("web"));
});

/**
 * Ship one digest-pinned build: stage it, materialize it as a zero-traffic
 * revision, verify that revision's digest, promote, apply, and settle from
 * readback. Every step after staging is fenced by the generation the step
 * before it wrote. A first release whose promotion never settled is
 * replaced by this build, staged and promoted in one step.
 */
const deliver = (
  config: WorkspaceStackConfig,
  input: DeliverReleaseInput,
  policy: ReleaseReadbackPolicy
) =>
  Effect.gen(function* () {
    const liveTemplate = yield* readLiveTemplate;
    const now = yield* DateTime.now;
    const staged = yield* runLockedReleaseStep((record) =>
      // The lost-record guard reads the very version this step replaces.
      requireRecordCoversLiveService(record).pipe(
        Effect.andThen(
          stage(record, {
            expectedGeneration: record.generation,
            sha: input.sha,
            imageDigest: input.imageDigest,
            origin: "cloud-run",
            liveTemplate,
            now,
          } satisfies StageInput)
        ),
        Effect.map(({ releaseId, promoted, record: next }) => ({
          record: next,
          result: {
            releaseId,
            promoted,
            generation: next.generation,
            candidate: next.candidate,
            active: next.active,
          },
        }))
      )
    );
    if (staged.promoted) {
      return yield* applyAndSettle(config, staged.generation, policy);
    }
    const { candidate, active } = staged;
    if (candidate === null) {
      return yield* Effect.die("A staged release record has no candidate");
    }
    // The very first release has no service yet: promotion creates it.
    const candidateReadback =
      active === null
        ? null
        : yield* applyAsWriter({
            action: "deploy",
            generation: staged.generation,
          }).pipe(Effect.andThen(observeCandidate(candidate, active, policy)));
    const promotedAt = yield* DateTime.now;
    const promotedGeneration = yield* runLockedReleaseStep((record) =>
      promote(record, {
        expectedGeneration: staged.generation,
        releaseId: staged.releaseId,
        now: promotedAt,
        candidateReadback,
      }).pipe(Effect.map((next) => ({ record: next, result: next.generation })))
    );
    return yield* applyAndSettle(config, promotedGeneration, policy);
  });

/** Deliver one build as the stage's only writer. */
export const deliverRelease = Effect.fn("WorkspaceRelease.deliver")(function* (
  config: WorkspaceStackConfig,
  input: DeliverReleaseInput,
  policy: ReleaseReadbackPolicy = defaultReleaseReadbackPolicy
) {
  return yield* deliver(config, input, policy).pipe(
    withReleaseWriter(config, "deliver")
  );
});

export interface RestoreReleaseInput {
  readonly releaseId: ReleaseId;
  /** The generation the operator saw; a newer decision refuses the restore. */
  readonly expectedGeneration: number;
}

/**
 * Move traffic back to the previous verified release, one still in its
 * compatible window, or the active release, and settle it from readback.
 * It supersedes a traffic change an earlier apply left pending.
 */
export const restoreRelease = Effect.fn("WorkspaceRelease.restore")(function* (
  config: WorkspaceStackConfig,
  input: RestoreReleaseInput,
  policy: ReleaseReadbackPolicy = defaultReleaseReadbackPolicy
) {
  return yield* Effect.gen(function* () {
    const now = yield* DateTime.now;
    const liveTemplate = yield* readLiveTemplate;
    const generation = yield* runLockedReleaseStep((record) =>
      restore(record, { ...input, now, liveTemplate }).pipe(
        Effect.map((next) => ({ record: next, result: next.generation }))
      )
    );
    return yield* applyAndSettle(config, generation, policy);
  }).pipe(withReleaseWriter(config, "restore"));
});

/**
 * Finish a traffic change an earlier run persisted but did not settle:
 * re-apply the same generation (apply is idempotent) and settle from
 * readback. Returns null when nothing is pending.
 */
export const recoverRelease = Effect.fn("WorkspaceRelease.recover")(function* (
  config: WorkspaceStackConfig,
  policy: ReleaseReadbackPolicy = defaultReleaseReadbackPolicy
) {
  return yield* Effect.gen(function* () {
    const { record } = yield* (yield* ReleaseRecordStore).read;
    if (record.pendingApply === null) {
      // "Nothing pending" from a lost record would hide the loss.
      yield* requireRecordCoversLiveService(record);
      return null;
    }
    return yield* applyAndSettle(config, record.generation, policy);
  }).pipe(withReleaseWriter(config, "recover"));
});

/**
 * Run the whole stack outside a release, such as an infrastructure change,
 * as the stage's only writer: `deploy` applies it and `plan` previews it.
 * It declares the current record, so a pending traffic change must be
 * recovered or restored first.
 */
export const runStack = Effect.fn("WorkspaceRelease.runStack")(function* (
  config: WorkspaceStackConfig,
  action: Extract<ReleaseOperation, "deploy" | "plan">
) {
  return yield* Effect.gen(function* () {
    const { record } = yield* (yield* ReleaseRecordStore).read;
    if (record.pendingApply !== null) {
      return yield* new ReleaseApplyPending({
        releaseId: record.pendingApply.target.releaseId,
      });
    }
    yield* applyAsWriter({ action, generation: null });
  }).pipe(withReleaseWriter(config, action));
});
