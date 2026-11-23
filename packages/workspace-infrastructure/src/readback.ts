import type {
  ImageDigest,
  WorkspaceStackConfig,
  WorkspaceWorkload,
} from "./config/stack-config";
import type { TrafficReadback } from "./release/release-reconciler";
import type { ReleaseRecord } from "./release/release-record";
import { trafficGenerationAnnotation } from "./resources/service-declarations";
import { workloadUrl } from "./resources/workload-names";

/** One traffic status row as Cloud Run reports it after an apply. */
export interface ObservedTrafficStatus {
  readonly revision: string;
  readonly percent: number;
  readonly tag?: string | undefined;
}

/** The fields of a live Cloud Run service the stack checks after apply. */
export interface ObservedService {
  readonly workload: WorkspaceWorkload;
  readonly uri: string | undefined;
  readonly urls: ReadonlyArray<string>;
  readonly ingress: string | undefined;
  readonly invokerIamDisabled: boolean;
  readonly terminalConditionState: string | undefined;
  readonly reconciling: boolean;
  readonly traffic: ReadonlyArray<ObservedTrafficStatus>;
  /** Image digest of each revision that carries traffic or a tag. */
  readonly revisionDigests: Readonly<Record<string, ImageDigest>>;
  /** Service annotations as Cloud Run reports them. */
  readonly annotations: Readonly<Record<string, string>>;
}

const observedTrafficGeneration = (observed: ObservedService) => {
  const value = observed.annotations[trafficGenerationAnnotation];
  return value !== undefined && /^[0-9]+$/.test(value) ? Number(value) : null;
};

export interface ReadbackDrift {
  readonly workload: WorkspaceWorkload;
  readonly field: string;
  readonly expected: string;
  readonly observed: string;
}

const expectedIngress: Record<WorkspaceWorkload, string> = {
  web: "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
  "tasks-worker": "INGRESS_TRAFFIC_INTERNAL_ONLY",
  "scheduler-worker": "INGRESS_TRAFFIC_INTERNAL_ONLY",
};

/**
 * The release-relevant view of live traffic: the single revision holding
 * all untagged traffic and its digest, or nulls while traffic is split,
 * reconciling or failed.
 */
export const trafficReadback = (observed: ObservedService): TrafficReadback => {
  const serving = observed.traffic.filter((entry) => entry.percent > 0);
  const [only] = serving;
  if (
    observed.reconciling ||
    observed.terminalConditionState !== "CONDITION_SUCCEEDED" ||
    serving.length !== 1 ||
    only === undefined ||
    only.percent !== 100
  ) {
    return {
      servingRevision: null,
      servingImageDigest: null,
      trafficGeneration: observedTrafficGeneration(observed),
    };
  }
  return {
    servingRevision: only.revision,
    servingImageDigest: observed.revisionDigests[only.revision] ?? null,
    trafficGeneration: observedTrafficGeneration(observed),
  };
};

/**
 * Drift between a live service and its declaration's fixed contract:
 * ingress, invoker IAM, and the deterministic worker URL queues and
 * schedules target.
 */
export const serviceReadbackDrift = (
  config: WorkspaceStackConfig,
  observed: ObservedService
): ReadonlyArray<ReadbackDrift> => {
  const drift = (field: string, expected: string, actual: string) =>
    expected === actual
      ? []
      : [{ workload: observed.workload, field, expected, observed: actual }];
  const isWorker = observed.workload !== "web";
  return [
    ...drift(
      "ingress",
      expectedIngress[observed.workload],
      observed.ingress ?? "<unset>"
    ),
    ...drift(
      "invokerIamDisabled",
      String(!isWorker),
      String(observed.invokerIamDisabled)
    ),
    ...(isWorker
      ? drift(
          "url",
          workloadUrl(config, observed.workload),
          observed.urls.find(
            (url) => url === workloadUrl(config, observed.workload)
          ) ??
            observed.uri ??
            "<unset>"
        )
      : []),
  ];
};

/**
 * A web service stamped with any traffic generation other than the
 * record's is drift: most likely a delayed write from an older run. The
 * record is not changed; an operator re-applies the current declaration.
 */
export const webTrafficDrift = (
  record: ReleaseRecord,
  observed: ObservedService
): ReadonlyArray<ReadbackDrift> => {
  const actual = observedTrafficGeneration(observed);
  return actual === record.trafficGeneration
    ? []
    : [
        {
          workload: "web",
          field: "trafficGeneration",
          expected: String(record.trafficGeneration),
          observed: actual === null ? "<unset>" : String(actual),
        },
      ];
};
