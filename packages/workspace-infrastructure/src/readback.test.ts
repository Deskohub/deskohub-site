import { describe, expect, test } from "bun:test";
import { ImageDigest } from "./config/stack-config";
import { sandboxConfig } from "./config/stack-config.test-utils";
import {
  type ObservedService,
  serviceReadbackDrift,
  trafficReadback,
  webTrafficDrift,
} from "./readback";
import {
  emptyReleaseRecord,
  GitSha,
  ReleaseId,
} from "./release/release-record";

const digest = ImageDigest.make(`sha256:${"1".repeat(64)}`);
const healthyWorker: ObservedService = {
  workload: "tasks-worker",
  uri: "https://workspace-tasks-worker-abc123-ew.a.run.app",
  urls: [
    "https://workspace-tasks-worker-123456789012.europe-west1.run.app",
    "https://workspace-tasks-worker-abc123-ew.a.run.app",
  ],
  ingress: "INGRESS_TRAFFIC_INTERNAL_ONLY",
  invokerIamDisabled: false,
  terminalConditionState: "CONDITION_SUCCEEDED",
  reconciling: false,
  traffic: [{ revision: "workspace-tasks-worker-00001", percent: 100 }],
  revisionDigests: { "workspace-tasks-worker-00001": digest },
  annotations: { "deskohub.workspace/traffic-generation": "4" },
};

describe("stack readback", () => {
  test("reports the single serving revision and its digest", () => {
    expect(trafficReadback(healthyWorker)).toEqual({
      servingRevision: "workspace-tasks-worker-00001",
      servingImageDigest: digest,
      trafficGeneration: 4,
    });
  });

  test("reports nothing while traffic is split, reconciling or failed", () => {
    for (const observed of [
      {
        ...healthyWorker,
        traffic: [
          { revision: "a", percent: 50 },
          { revision: "b", percent: 50 },
        ],
      },
      { ...healthyWorker, reconciling: true },
      { ...healthyWorker, terminalConditionState: "CONDITION_FAILED" },
    ]) {
      expect(trafficReadback(observed)).toEqual({
        servingRevision: null,
        servingImageDigest: null,
        trafficGeneration: 4,
      });
    }
  });

  test("flags drift from the deterministic URL, ingress and invoker policy", () => {
    expect(serviceReadbackDrift(sandboxConfig, healthyWorker)).toEqual([]);
    expect(
      serviceReadbackDrift(sandboxConfig, {
        ...healthyWorker,
        urls: [],
        ingress: "INGRESS_TRAFFIC_ALL",
        invokerIamDisabled: true,
      }).map((drift) => drift.field)
    ).toEqual(["ingress", "invokerIamDisabled", "url"]);
  });

  test("flags web traffic that differs from the release record", () => {
    const active = {
      releaseId: ReleaseId.make("r1-aaaaaaa"),
      sha: GitSha.make("a".repeat(40)),
      imageDigest: digest,
      origin: "cloud-run" as const,
      revision: "workspace-web-r1-aaaaaaa",
      verifiedAt: "2026-11-22T10:00:00.000Z",
    };
    const record = {
      ...emptyReleaseRecord,
      trafficGeneration: 4,
      active,
      materialized: active,
    };
    const web: ObservedService = {
      ...healthyWorker,
      workload: "web",
      traffic: [{ revision: active.revision, percent: 100 }],
      revisionDigests: { [active.revision]: digest },
    };
    const fields = (observed: ObservedService) =>
      webTrafficDrift(record, observed).map((drift) => drift.field);
    expect(fields(web)).toEqual([]);
    // A delayed write from an older run.
    expect(
      fields({
        ...web,
        annotations: { "deskohub.workspace/traffic-generation": "3" },
      })
    ).toEqual(["trafficGeneration"]);
    // The current stamp, but all traffic on another revision.
    expect(
      fields({
        ...web,
        traffic: [{ revision: "workspace-web-r9-fffffff", percent: 100 }],
        revisionDigests: { "workspace-web-r9-fffffff": digest },
      })
    ).toEqual(["servingRevision"]);
    // Split traffic is unavailable, never a pass.
    expect(
      webTrafficDrift(record, {
        ...web,
        traffic: [
          { revision: active.revision, percent: 50 },
          { revision: "workspace-web-r9-fffffff", percent: 50 },
        ],
      }).map((drift) => drift.observed)
    ).toEqual(["<unavailable>", "<unavailable>"]);
  });
});
