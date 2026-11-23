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
  type ObservedService,
  type ReadbackDrift,
  serviceReadbackDrift,
  trafficReadback,
} from "../readback";
import { releaseTrafficTag } from "../resources/service-declarations";
import {
  ReleaseServiceApply,
  ReleaseServiceReadback,
} from "./release-platform";
import {
  CandidateNotVerified,
  promote,
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
  ReleaseRecord,
  VerifiedDeployment,
} from "./release-record";
import { ReleaseRecordStore, runReleaseStep } from "./release-record-store";

/**
 * A release-owned service no longer matches its fixed contract (ingress,
 * invoker IAM, worker URL) or is missing after an apply. Traffic is not
 * settled over it.
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

/**
 * The record names no serving release, yet a release-owned service is
 * live: the record object was deleted or reset. Nothing proceeds from it, because a
 * fresh history would skip candidate verification and drop the previous
 * release; an operator restores the object's last good version instead.
 */
export class ReleaseRecordLost extends Data.TaggedError("ReleaseRecordLost")<{
  readonly liveWorkloads: ReadonlyArray<WorkspaceWorkload>;
  readonly liveRevisions: ReadonlyArray<string>;
}> {}

const releaseWorkloads: ReadonlyArray<WorkspaceWorkload> = [
  "web",
  "tasks-worker",
  "scheduler-worker",
];

/** Every release-owned service as Cloud Run reports it now. */
const observeReleaseServices = Effect.gen(function* () {
  const readback = yield* ReleaseServiceReadback;
  return yield* Effect.forEach(releaseWorkloads, (workload) =>
    readback
      .service(workload)
      .pipe(Effect.map((service) => ({ workload, service })))
  );
});

/**
 * Refuse a record without a serving release while the web service or
 * either worker exists. Callers run it on the record version they are about
 * to write over, so no newer record slips in between check and write.
 */
export const requireRecordCoversLiveService = (record: ReleaseRecord) =>
  Effect.gen(function* () {
    if (record.active !== null || record.pendingApply !== null) {
      return;
    }
    const live = (yield* observeReleaseServices).flatMap(
      ({ workload, service }) =>
        service === null ? [] : [{ workload, service }]
    );
    if (live.length > 0) {
      return yield* new ReleaseRecordLost({
        liveWorkloads: live.map(({ workload }) => workload),
        liveRevisions: live.flatMap(({ service }) =>
          service.traffic.map((entry) => entry.revision)
        ),
      });
    }
  });

const unavailableTraffic: TrafficReadback = {
  servingRevision: null,
  servingImageDigest: null,
  trafficGeneration: null,
};

/**
 * A service's drift from its fixed contract. The web service may not exist
 * before its first apply lands, which traffic readback already reports; a
 * missing worker after an apply is drift.
 */
const contractDrift = (
  config: WorkspaceStackConfig,
  workload: WorkspaceWorkload,
  service: ObservedService | null
): ReadonlyArray<ReadbackDrift> => {
  if (service !== null) {
    return serviceReadbackDrift(config, service);
  }
  if (workload === "web") {
    return [];
  }
  return [
    {
      workload,
      field: "service",
      expected: "<declared>",
      observed: "<missing>",
    },
  ];
};

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
    const drift = observed.flatMap(({ workload, service }) =>
      contractDrift(config, workload, service)
    );
    if (drift.length > 0) {
      return yield* new ReleaseServiceDrift({ drift });
    }
    const readbackOf = (service: ObservedService | null) =>
      service === null ? unavailableTraffic : trafficReadback(service);
    const web = observed.find((entry) => entry.workload === "web");
    const now = yield* DateTime.now;
    return yield* runReleaseStep((record) =>
      settleApply(record, {
        expectedGeneration,
        readback: readbackOf(web?.service ?? null),
        workers: observed
          .filter((entry) => entry.workload !== "web")
          .map((entry) => readbackOf(entry.service)),
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
    const platform = yield* ReleaseServiceApply;
    yield* platform.apply(generation);
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

/**
 * Ship one digest-pinned build: stage it, materialize it as a zero-traffic
 * revision, verify that revision's digest, promote, apply, and settle from
 * readback. Every step after staging is fenced by the generation the step
 * before it wrote.
 */
export const deliverRelease = Effect.fn("WorkspaceRelease.deliver")(function* (
  config: WorkspaceStackConfig,
  input: DeliverReleaseInput,
  policy: ReleaseReadbackPolicy = defaultReleaseReadbackPolicy
) {
  const staged = yield* runReleaseStep((record) =>
    // The lost-record guard reads the very version this step replaces.
    requireRecordCoversLiveService(record).pipe(
      Effect.andThen(
        stage(record, {
          expectedGeneration: record.generation,
          sha: input.sha,
          imageDigest: input.imageDigest,
          origin: "cloud-run",
        } satisfies StageInput)
      ),
      Effect.map(({ releaseId, record: next }) => ({
        record: next,
        result: {
          releaseId,
          generation: next.generation,
          candidate: next.candidate,
          active: next.active,
        },
      }))
    )
  );
  const { candidate, active } = staged;
  if (candidate === null) {
    return yield* Effect.die("A staged release record has no candidate");
  }
  // The very first release has no service yet: promotion creates it.
  const candidateReadback =
    active === null
      ? null
      : yield* Effect.gen(function* () {
          const platform = yield* ReleaseServiceApply;
          yield* platform.apply(staged.generation);
          return yield* observeCandidate(candidate, active, policy);
        });
  const now = yield* DateTime.now;
  const promotedGeneration = yield* runReleaseStep((record) =>
    promote(record, {
      expectedGeneration: staged.generation,
      releaseId: staged.releaseId,
      now,
      candidateReadback,
    }).pipe(Effect.map((next) => ({ record: next, result: next.generation })))
  );
  return yield* applyAndSettle(config, promotedGeneration, policy);
});

export interface RestoreReleaseInput {
  readonly releaseId: ReleaseId;
  /** The generation the operator saw; a newer decision refuses the restore. */
  readonly expectedGeneration: number;
}

/**
 * Move traffic back to the previous verified release, or one still in its
 * compatible window, and settle it from readback.
 */
export const restoreRelease = Effect.fn("WorkspaceRelease.restore")(function* (
  config: WorkspaceStackConfig,
  input: RestoreReleaseInput,
  policy: ReleaseReadbackPolicy = defaultReleaseReadbackPolicy
) {
  const now = yield* DateTime.now;
  const web = yield* (yield* ReleaseServiceReadback).service("web");
  const generation = yield* runReleaseStep((record) =>
    restore(record, {
      ...input,
      now,
      liveTemplateRevision: web?.templateRevision ?? null,
    }).pipe(Effect.map((next) => ({ record: next, result: next.generation })))
  );
  return yield* applyAndSettle(config, generation, policy);
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
  const store = yield* ReleaseRecordStore;
  const { record } = yield* store.read;
  if (record.pendingApply === null) {
    // "Nothing pending" from a lost record would hide the loss.
    yield* requireRecordCoversLiveService(record);
    return null;
  }
  return yield* applyAndSettle(config, record.generation, policy);
});
