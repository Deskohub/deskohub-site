import { describe, expect, test } from "bun:test";
import { ImageDigest } from "./config/stack-config";
import { sandboxConfig } from "./config/stack-config.test-utils";
import {
  type ObservedService,
  serviceReadbackDrift,
  trafficReadback,
  webTrafficDrift,
} from "./readback";
import { emptyReleaseRecord } from "./release/release-record";

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

  test("flags a web service stamped by another traffic generation", () => {
    const record = { ...emptyReleaseRecord, trafficGeneration: 4 };
    const web = { ...healthyWorker, workload: "web" as const };
    expect(webTrafficDrift(record, web)).toEqual([]);
    expect(
      webTrafficDrift(record, {
        ...web,
        annotations: { "deskohub.workspace/traffic-generation": "3" },
      })
    ).toEqual([
      {
        workload: "web",
        field: "trafficGeneration",
        expected: "4",
        observed: "3",
      },
    ]);
  });
});
