import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type FakeRule,
  type FakeWorld,
  fakeWriterFingerprint,
  type ProofFakes,
  withProofFakes,
} from "./sandbox-proof-fakes.test-utils";

/**
 * Behavioural tests of the hosted proof runner's live paths against
 * stateful fake CLIs: nothing here reaches Google Cloud.
 */

const runner = new URL("../scripts/sandbox-hosted-proof.sh", import.meta.url)
  .pathname;
const packageRoot = new URL("..", import.meta.url).pathname;

const projectId = "deskohub-workspace-sandbox";
const stateBucket = "deskohub-workspace-sandbox-workspace-state";
const stackPrefix = "DeskohubWorkspace/sandbox/";
const lease = `${stackPrefix}__lease__.json`;
const exclusionName = "workspace-sandbox-token-route-requests";
const traceId = "0123456789abcdef0123456789abcdef";
const v3Digest = `sha256:${"3".repeat(64)}`;

const sandboxEnv = {
  GCP_SANDBOX_PROJECT_ID: projectId,
  GCP_SANDBOX_STATE_BUCKET: stateBucket,
  SANDBOX_EXPECTED_PROJECT_ID: projectId,
  SANDBOX_EXPECTED_PROJECT_NUMBER: "759037106024",
  SANDBOX_EXPECTED_STATE_BUCKET: stateBucket,
  SANDBOX_REGION: "europe-west1",
  SANDBOX_PROOF_MODE: "hosted-proof",
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: "1".repeat(40),
  GITHUB_RUN_ID: "111",
  GITHUB_RUN_ATTEMPT: "1",
  GOOGLE_ACCESS_TOKEN: "fake-access-token",
  // Far in the future, so the runner never mints a token.
  GOOGLE_ACCESS_TOKEN_MINTED_AT: "99999999999",
};

const runPhase = (
  fakes: ProofFakes,
  phase: string,
  env: Record<string, string> = {}
) => {
  const result = Bun.spawnSync(["bash", runner, phase], {
    cwd: packageRoot,
    env: {
      HOME: process.env.HOME ?? "/tmp",
      ...sandboxEnv,
      ...fakes.env,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
};

const seed = (fakes: ProofFakes, files: Record<string, string>) => {
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(fakes.proofDir, name), content);
  }
};

const settled = (digest?: string) => ({
  version: "1",
  record: {
    generation: 3,
    writer: null,
    pendingApply: null,
    ...(digest === undefined
      ? {}
      : { active: { imageDigest: digest, releaseId: "release-3" } }),
  },
});

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("cleanup under the writer lock", () => {
  const directDeletes =
    /run services delete|tasks queues delete|artifacts repositories delete/;

  test("stops when the stale writer lock cannot be released", () => {
    withProofFakes(
      {
        status: {
          version: "1",
          record: {
            generation: 4,
            writer: { holder: "h" },
            pendingApply: null,
          },
        },
        rules: [
          { tool: "bun", pattern: "^release\\.run\\.ts unlock", exit: 1 },
        ],
      },
      (fakes) => {
        seed(fakes, {
          "stack-config.json": "{}",
          "interrupted-dead-holder": "h\n",
        });
        const { exitCode, output } = runPhase(fakes, "stack-destroy");
        expect(exitCode).toBe(1);
        expect(output).toContain("was not released; nothing was destroyed");
        const calls = fakes.calls().join("\n");
        expect(calls).not.toMatch(directDeletes);
        expect(calls).not.toContain("sandbox-locked-stack.ts destroy");
        expect(calls).not.toContain("storage rm");
      }
    );
  });

  const heldBy = (holder: string, rules: ReadonlyArray<FakeRule> = []) => ({
    status: {
      version: "1",
      record: { generation: 4, writer: { holder }, pendingApply: null },
    },
    rules,
  });

  test("leaves a lock whose holder this run did not prove dead", () => {
    for (const deadHolder of [null, "another-holder"]) {
      withProofFakes(heldBy("live-holder"), (fakes) => {
        seed(fakes, {
          "stack-config.json": "{}",
          ...(deadHolder === null
            ? {}
            : { "interrupted-dead-holder": `${deadHolder}\n` }),
        });
        const { exitCode, output } = runPhase(fakes, "stack-destroy");
        expect(exitCode).toBe(1);
        expect(output).toContain("whose death this run did not establish");
        const calls = fakes.calls().join("\n");
        expect(calls).not.toContain("unlock");
        expect(calls).not.toContain("sandbox-locked-stack.ts destroy");
      });
    }
  });

  test("leaves the lock when the Alchemy lease is unreadable", () => {
    const leaseRead = "storage\\.googleapis\\.com/storage/v1/b/.*__lease__";
    for (const failure of [
      // Expired or missing credentials, worded like an absent object.
      { stdout: '{"error":{"code":401,"message":"File not found"}}\n401' },
      // A 404 for the bucket, not the lease object.
      {
        stdout:
          '{"error":{"code":404,"message":"The specified bucket does not exist."}}\n404',
      },
      // A transport failure.
      { exit: 7 },
    ]) {
      withProofFakes(
        heldBy("h", [{ tool: "curl", pattern: leaseRead, ...failure }]),
        (fakes) => {
          seed(fakes, {
            "stack-config.json": "{}",
            "interrupted-dead-holder": "h\n",
          });
          const { exitCode, output } = runPhase(fakes, "stack-destroy");
          expect({ failure, exitCode }).toEqual({ failure, exitCode: 1 });
          expect(output).toContain("the Alchemy lease is unreadable");
          expect(fakes.calls().join("\n")).not.toContain("unlock");
        }
      );
    }
  });

  test("reads a missing lease object as absent, not unreadable", () => {
    withProofFakes(heldBy("h"), (fakes) => {
      seed(fakes, {
        "stack-config.json": "{}",
        "interrupted-dead-holder": "h\n",
      });
      const { output } = runPhase(fakes, "stack-destroy");
      expect(output).not.toContain("the Alchemy lease is unreadable");
      expect(fakes.calls().join("\n")).toContain("unlock --holder h");
    });
  });

  test("deletes nothing outside the lock when the locked destroy is refused", () => {
    withProofFakes(
      {
        status: settled(),
        rules: [
          {
            tool: "bun",
            pattern: "^scripts/sandbox-locked-stack\\.ts destroy",
            exit: 1,
          },
        ],
      },
      (fakes) => {
        seed(fakes, { "stack-config.json": "{}" });
        const { exitCode, output } = runPhase(fakes, "stack-destroy");
        expect(exitCode).toBe(1);
        expect(output).toContain("nothing was deleted outside the lock");
        const calls = fakes.calls().join("\n");
        expect(calls).not.toMatch(directDeletes);
        expect(calls).not.toContain("storage rm");
      }
    );
  });
});

describe("teardown deadline", () => {
  const deadline = Date.parse("2026-11-30T23:59:59Z") / 1000;
  const hour = 3600;
  const preflightRules: ReadonlyArray<FakeRule> = [
    { tool: "gcloud", pattern: "^projects describe", stdout: "759037106024" },
    {
      tool: "gcloud",
      pattern: "^storage buckets describe",
      stdout: "EUROPE-WEST1",
    },
  ];
  const preflight = (now: number, mode: string) =>
    withProofFakes({ now, rules: preflightRules }, (fakes) =>
      runPhase(fakes, "preflight", { SANDBOX_PROOF_MODE: mode })
    );

  test("lets hosted-proof start only a day before the deadline", () => {
    expect(preflight(deadline - 25 * hour, "hosted-proof").exitCode).toBe(0);
    const late = preflight(deadline - 23 * hour, "hosted-proof");
    expect(late.exitCode).toBe(1);
    expect(late.output).toContain("only cleanup-only may run now");
    expect(preflight(deadline + hour, "hosted-proof").exitCode).toBe(1);
  });

  test("keeps cleanup-only available after the deadline", () => {
    expect(preflight(deadline - 23 * hour, "cleanup-only").exitCode).toBe(0);
    const expired = preflight(deadline + 48 * hour, "cleanup-only");
    expect(expired.exitCode).toBe(0);
    expect(expired.output).toContain("teardown deadline has passed");
  });
});

describe("disposable queue IDs", () => {
  const foundation = (runId: string) =>
    withProofFakes({}, (fakes) => {
      const { exitCode, output } = runPhase(fakes, "foundation", {
        GITHUB_RUN_ID: runId,
        GITHUB_RUN_ATTEMPT: "2",
      });
      const config = JSON.parse(
        readFileSync(join(fakes.proofDir, "stack-config.json"), "utf8")
      ) as { disposableQueueSuffix?: string };
      return {
        exitCode,
        output,
        suffix: config.disposableQueueSuffix,
        recorded: fakes.world().files?.["sandbox-proof/run.env"],
        calls: fakes.calls(),
      };
    });

  test("declare a fresh suffix per run and record it before the deploy", () => {
    const first = foundation("111");
    expect(first.exitCode).toBe(0);
    expect(first.suffix).toBe("r111-2");
    expect(first.recorded).toContain("QUEUE_SUFFIX=r111-2");
    const upload = first.calls.findIndex((call) =>
      call.includes("sandbox-proof/run.env")
    );
    const deploy = first.calls.findIndex((call) =>
      call.startsWith("bun release.run.ts deploy")
    );
    expect(upload).toBeGreaterThan(-1);
    expect(upload).toBeLessThan(deploy);
    expect(foundation("112").suffix).toBe("r112-2");
  });

  test("never executes the recorded proof run file", () => {
    for (const record of [
      "QUEUE_SUFFIX=r111-2\ntouch pwned\n",
      "QUEUE_SUFFIX=$(touch pwned)\n",
      "QUEUE_SUFFIX=r111-2;touch_pwned\n",
      // A valid suffix cannot smuggle in another setting.
      "QUEUE_SUFFIX=r111-2\nSANDBOX_PROOF_MODE=cleanup-only\n",
      "QUEUE_SUFFIX=r111-2\nQUEUE_SUFFIX=r112-1\n",
    ]) {
      withProofFakes(
        {
          files: { "sandbox-proof/run.env": record },
          rules: [
            {
              tool: "gcloud",
              pattern: "^projects describe",
              stdout: "759037106024",
            },
            {
              tool: "gcloud",
              pattern: "^storage buckets describe",
              stdout: "europe-west1",
            },
          ],
        },
        (fakes) => {
          const { exitCode, output } = runPhase(fakes, "preflight", {
            SANDBOX_PROOF_MODE: "cleanup-only",
          });
          expect({ record, exitCode }).toEqual({ record, exitCode: 1 });
          expect(output).toContain("not exactly one valid QUEUE_SUFFIX");
          expect(
            existsSync(join(packageRoot, "pwned")) ||
              existsSync(join(fakes.proofDir, "pwned"))
          ).toBe(false);
        }
      );
    }
  });

  test("reuse the recorded suffix in a later cleanup-only run", () => {
    withProofFakes(
      {
        files: { "sandbox-proof/run.env": "QUEUE_SUFFIX=r111-2\n" },
        rules: [
          {
            tool: "gcloud",
            pattern: "^projects describe",
            stdout: "759037106024",
          },
          {
            tool: "gcloud",
            pattern: "^storage buckets describe",
            stdout: "europe-west1",
          },
        ],
      },
      (fakes) => {
        const { exitCode } = runPhase(fakes, "preflight", {
          SANDBOX_PROOF_MODE: "cleanup-only",
        });
        expect(exitCode).toBe(0);
        const config = JSON.parse(
          readFileSync(join(fakes.proofDir, "stack-config.json"), "utf8")
        ) as { disposableQueueSuffix?: string };
        expect(config.disposableQueueSuffix).toBe("r111-2");
      }
    );
  });
});

describe("state snapshot and restore", () => {
  const stateWorld = (): FakeWorld => ({
    listNoncurrent: true,
    nextGeneration: 100,
    objects: {
      [`${stackPrefix}Service.json`]: {
        live: "5",
        generations: { "3": "crc-service-3", "5": "crc-service-5" },
      },
      [`${stackPrefix}Queue.json`]: {
        live: "7",
        generations: { "6": "crc-queue-6", "7": "crc-queue-7" },
      },
      [lease]: { live: "9", generations: { "9": "crc-lease" } },
    },
  });
  const locked = { WORKSPACE_RELEASE_WRITER: "fake-writer" };
  const manifest = (fakes: ProofFakes, file: string) =>
    JSON.parse(readFileSync(join(fakes.proofDir, file), "utf8"));

  test("snapshots one live generation per object despite noncurrent history", () => {
    withProofFakes(stateWorld(), (fakes) => {
      const { exitCode, output } = runPhase(
        fakes,
        "state-snapshot-locked",
        locked
      );
      expect({ exitCode, output: exitCode === 0 ? "" : output }).toEqual({
        exitCode: 0,
        output: "",
      });
      expect(manifest(fakes, "state-live.json")).toEqual([
        {
          name: `${stackPrefix}Queue.json`,
          generation: "7",
          crc32c: "crc-queue-7",
        },
        {
          name: `${stackPrefix}Service.json`,
          generation: "5",
          crc32c: "crc-service-5",
        },
      ]);
    });
  });

  test("refuses to snapshot or restore without the writer lock", () => {
    withProofFakes(stateWorld(), (fakes) => {
      for (const phase of ["state-snapshot-locked", "state-restore-locked"]) {
        const { exitCode, output } = runPhase(fakes, phase);
        expect(exitCode).toBe(1);
        expect(output).toContain("runs only under the writer lock");
      }
      expect(fakes.calls()).toEqual([]);
    });
  });

  test("restores the snapshot generations and verifies the live objects", () => {
    withProofFakes(stateWorld(), (fakes) => {
      expect(runPhase(fakes, "state-snapshot-locked", locked).exitCode).toBe(0);
      seed(fakes, {
        "state-snapshot.json": readFileSync(
          join(fakes.proofDir, "state-live.json"),
          "utf8"
        ),
      });
      // A tracked change: one object rewritten, one removed, one added.
      const world = fakes.world();
      const objects = { ...world.objects };
      objects[`${stackPrefix}Service.json`] = {
        live: "11",
        generations: {
          "3": "crc-service-3",
          "5": "crc-service-5",
          "11": "crc-service-11",
        },
      };
      objects[`${stackPrefix}Queue.json`] = {
        live: null,
        generations: { "6": "crc-queue-6", "7": "crc-queue-7" },
      };
      objects[`${stackPrefix}Extra.json`] = {
        live: "12",
        generations: { "12": "crc-extra" },
      };
      writeFileSync(
        fakes.env.FAKE_WORLD ?? "",
        JSON.stringify({ ...world, objects })
      );

      const { exitCode, output } = runPhase(
        fakes,
        "state-restore-locked",
        locked
      );
      expect({ exitCode, output: exitCode === 0 ? "" : output }).toEqual({
        exitCode: 0,
        output: "",
      });
      const restored = fakes.world().objects ?? {};
      const liveCrc = (name: string) => {
        const object = restored[`${stackPrefix}${name}`];
        return object?.live == null ? null : object.generations[object.live];
      };
      expect(liveCrc("Service.json")).toBe("crc-service-5");
      expect(liveCrc("Queue.json")).toBe("crc-queue-7");
      expect(liveCrc("Extra.json")).toBeNull();
      expect(restored[lease]?.live).toBe("9");
      const writes = fakes
        .calls()
        .filter((call) => / storage (cp|rm) /.test(` ${call}`));
      expect(writes).toEqual([
        `gcloud storage cp gs://${stateBucket}/${stackPrefix}Queue.json#7 gs://${stateBucket}/${stackPrefix}Queue.json --if-generation-match=0`,
        `gcloud storage cp gs://${stateBucket}/${stackPrefix}Service.json#5 gs://${stateBucket}/${stackPrefix}Service.json --if-generation-match=11`,
        `gcloud storage rm gs://${stateBucket}/${stackPrefix}Extra.json --if-generation-match=12`,
      ]);
    });
  });

  test("fails when a restored object does not read back as the snapshot", () => {
    withProofFakes(stateWorld(), (fakes) => {
      expect(runPhase(fakes, "state-snapshot-locked", locked).exitCode).toBe(0);
      const snapshot = manifest(fakes, "state-live.json") as Array<{
        crc32c: string;
      }>;
      snapshot[0] = { ...snapshot[0], crc32c: "crc-never-written" } as {
        crc32c: string;
      };
      seed(fakes, { "state-snapshot.json": JSON.stringify(snapshot) });
      const { exitCode, output } = runPhase(
        fakes,
        "state-restore-locked",
        locked
      );
      expect(exitCode).toBe(1);
      expect(output).toContain("do not match the snapshot");
    });
  });
});

describe("interrupting a deliver mid-apply", () => {
  const interruptWorld = (
    behaviour: NonNullable<FakeWorld["interruptedDeliver"]>
  ): FakeWorld => ({
    interruptedDeliver: behaviour,
    serviceGenerations: {
      "workspace-web": 4,
      "workspace-tasks-worker": 2,
      "workspace-scheduler-worker": 2,
    },
    status: settled(`sha256:${"2".repeat(64)}`),
    rules: [
      {
        tool: "bun",
        pattern: `^release\\.run\\.ts unlock --holder ${fakeWriterFingerprint}$`,
        set: { status: settled(`sha256:${"2".repeat(64)}`) },
      },
      {
        tool: "bun",
        pattern: "^release\\.run\\.ts plan$",
        stdout: "Plan: no changes",
      },
      {
        tool: "curl",
        pattern: "/healthz$",
        stdout: '{"status":"ok","version":"v3"}',
      },
    ],
  });
  const seedDeliver = (fakes: ProofFakes) =>
    seed(fakes, {
      "stack-config.json": "{}",
      "digests.env": `PROBE_V3_DIGEST=${v3Digest}\n`,
      "edge.env": "EDGE_IP=198.51.100.10\n",
    });

  test("kills the apply's detached child before unlocking and redelivers", () => {
    withProofFakes(interruptWorld("apply"), (fakes) => {
      seedDeliver(fakes);
      // The rerun deliver, without the interrupt token, settles v3.
      const world = fakes.world();
      writeFileSync(
        fakes.env.FAKE_WORLD ?? "",
        JSON.stringify({
          ...world,
          rules: [
            ...(world.rules ?? []),
            {
              tool: "bun",
              pattern: "^release\\.run\\.ts deliver .*--image-digest",
              set: { status: settled(v3Digest) },
            },
          ],
        })
      );
      const { exitCode, output } = runPhase(fakes, "interrupt-recover");
      const child = fakes.world().detachedChildPid;
      expect(child).toBeNumber();
      const alive = child === undefined ? false : isAlive(child);
      if (alive && child !== undefined) {
        process.kill(child, "SIGKILL");
      }
      expect({ exitCode, output: exitCode === 0 ? "" : output }).toEqual({
        exitCode: 0,
        output: "",
      });
      expect(alive).toBe(false);
      const calls = fakes.calls();
      const unlock = calls.findIndex((call) =>
        call.startsWith(
          `bun release.run.ts unlock --holder ${fakeWriterFingerprint}`
        )
      );
      const redeliver = calls.findLastIndex((call) =>
        call.startsWith("bun release.run.ts deliver")
      );
      expect(unlock).toBeGreaterThan(-1);
      expect(redeliver).toBeGreaterThan(unlock);
    });
  });

  test("leaves a lock another writer took after the deliver was killed", () => {
    const world = interruptWorld("apply");
    withProofFakes(
      {
        ...world,
        rules: [
          // By the lease check after the kill, another writer holds the lock.
          {
            tool: "curl",
            pattern: "storage\\.googleapis\\.com/storage/v1/b/.*__lease__",
            stdout: '{"generation":"9"}\n200',
            set: {
              status: {
                version: "1",
                record: {
                  generation: 8,
                  writer: { holder: "0123456789ab" },
                  pendingApply: null,
                },
              },
            },
          },
          ...(world.rules ?? []),
        ],
      },
      (fakes) => {
        seedDeliver(fakes);
        const { exitCode, output } = runPhase(fakes, "interrupt-recover");
        const child = fakes.world().detachedChildPid;
        if (child !== undefined && isAlive(child)) {
          process.kill(child, "SIGKILL");
        }
        expect(exitCode).toBe(1);
        expect(output).toContain("not the killed deliver");
        expect(fakes.calls().join("\n")).not.toContain("unlock");
      }
    );
  });

  test("fails without a baseline generation read", () => {
    const world = interruptWorld("apply");
    withProofFakes(
      {
        ...world,
        rules: [
          {
            tool: "gcloud",
            pattern: "^run services describe workspace-web ",
            exit: 1,
          },
          ...(world.rules ?? []),
        ],
      },
      (fakes) => {
        seedDeliver(fakes);
        const { exitCode, output } = runPhase(fakes, "interrupt-recover");
        expect(exitCode).toBe(1);
        expect(output).toContain("the interrupt has no baseline");
        expect(fakes.calls().join("\n")).not.toContain("deliver");
      }
    );
  });

  test("never counts a failed generation read as a change", () => {
    withProofFakes(
      {
        ...interruptWorld("exit-after-failed-read"),
        serviceReadsFailAfterDeliver: true,
      },
      (fakes) => {
        seedDeliver(fakes);
        const { exitCode, output } = runPhase(fakes, "interrupt-recover");
        expect(fakes.world().failedServiceReads).toBeGreaterThan(0);
        expect(exitCode).toBe(1);
        expect(output).toContain("persisted no Cloud Run change");
        expect(fakes.calls().join("\n")).not.toContain("unlock");
      }
    );
  });

  test("fails when the deliver ends before persisting any change", () => {
    withProofFakes(interruptWorld("exit"), (fakes) => {
      seedDeliver(fakes);
      const { exitCode, output } = runPhase(fakes, "interrupt-recover");
      expect(exitCode).toBe(1);
      expect(output).toContain("persisted no Cloud Run change");
      expect(fakes.calls().join("\n")).not.toContain("unlock");
    });
  });
});

describe("token-route privacy and telemetry", () => {
  // The filter Terraform builds in infra/workspace-edge/request-log-exclusions.tf.
  const lbSource = 'resource.type="http_load_balancer"';
  const runSource =
    'resource.type="cloud_run_revision" AND log_id("run.googleapis.com/requests")';
  const routes =
    "/app/auth/callback|/api/auth/magic-link/verify|/api/email-campaigns/unsubscribe|(/[a-z]{2,3}-[A-Z]{2})?/marketing-preferences/access";
  const exclusionFilter = `(${lbSource} OR (${runSource})) AND httpRequest.requestUrl=~"^https?://[^/]+(${routes})([/?#]|$)"`;
  const exclusions = JSON.stringify({
    exclusions: [{ name: exclusionName, filter: exclusionFilter }],
  });
  const projectSinks = [
    { name: "_Required", destination: "logging/_Required" },
    { name: "_Default", destination: "logging/_Default" },
  ];
  const traceBody = JSON.stringify({
    traceId,
    spans: [{ name: "sandbox-probe.synthetic" }],
  });
  const rules = (
    overrides: ReadonlyArray<FakeRule> = []
  ): ReadonlyArray<FakeRule> => [
    ...overrides,
    {
      tool: "curl",
      pattern: "logging\\.googleapis\\.com/v2/projects/.*/exclusions",
      stdout: exclusions,
    },
    {
      tool: "gcloud",
      pattern: "^projects get-ancestors",
      stdout: JSON.stringify([
        { id: projectId, type: "project" },
        { id: "4242", type: "folder" },
      ]),
    },
    {
      tool: "gcloud",
      pattern: "^logging sinks list --project=",
      stdout: JSON.stringify(projectSinks),
    },
    {
      tool: "gcloud",
      pattern: "^logging sinks list --folder=4242",
      stdout: JSON.stringify([
        { name: "_Default", destination: "logging/folder" },
      ]),
    },
    {
      tool: "curl",
      pattern: "/healthz$",
      stdout: JSON.stringify({
        status: "ok",
        version: "v1",
        otlp: { traceId, status: 200 },
      }),
    },
    {
      tool: "gcloud",
      pattern: "^logging read .*jsonPayload\\.otlp\\.traceId",
      stdout: '[{"timestamp":"2026-11-23T10:00:00Z"}]',
    },
    {
      tool: "curl",
      pattern: `cloudtrace\\.googleapis\\.com/v1/projects/${projectId}/traces/${traceId}$`,
      stdout: traceBody,
    },
    {
      tool: "curl",
      pattern: "token=synthetic-probe-marker",
      stdout: '{"route":"/x"}',
    },
    {
      tool: "gcloud",
      pattern: "^logging read .*run\\.googleapis\\.com/requests",
      stdout: '[{"timestamp":"2026-11-23T10:01:00Z"}]',
    },
    {
      tool: "gcloud",
      pattern: '^logging read "synthetic-probe-marker"',
      stdout: "[]",
    },
    {
      tool: "curl",
      pattern: "cloudtrace\\.googleapis\\.com/v1/projects/.*/traces\\?",
      stdout: JSON.stringify({ traces: [{ traceId }] }),
    },
  ];
  const privacy = (
    overrides: ReadonlyArray<FakeRule> = [],
    recordedFilter: string | null = exclusionFilter
  ) =>
    withProofFakes({ rules: rules(overrides) }, (fakes) => {
      seed(fakes, {
        "edge.env": "EDGE_IP=198.51.100.10\n",
        ...(recordedFilter === null
          ? {}
          : { "edge-exclusion-filter.txt": recordedFilter }),
      });
      const result = runPhase(fakes, "edge-privacy");
      return {
        ...result,
        markerSent: fakes
          .calls()
          .some((call) => call.includes("token=synthetic-probe-marker")),
      };
    });

  test("passes once routing, the probe log and its span are verified", () => {
    const { exitCode, output, markerSent } = privacy();
    expect({ exitCode, output: exitCode === 0 ? "" : output }).toEqual({
      exitCode: 0,
      output: "",
    });
    expect(markerSent).toBe(true);
  });

  test("fails on an empty or denied trace read", () => {
    const empty = privacy([
      {
        tool: "curl",
        pattern: `traces/${traceId}$`,
        stdout: "{}",
      },
    ]);
    expect(empty.exitCode).toBe(1);
    expect(empty.output).toContain("no sandbox-probe.synthetic span");
    const denied = privacy([
      { tool: "curl", pattern: `traces/${traceId}$`, exit: 22 },
    ]);
    expect(denied.exitCode).toBe(1);
    expect(denied.markerSent).toBe(false);
  });

  test("fails without the probe's current structured log", () => {
    const { exitCode, output } = privacy([
      {
        tool: "gcloud",
        pattern: "^logging read .*jsonPayload\\.otlp\\.traceId",
        stdout: "[]",
      },
    ]);
    expect(exitCode).toBe(1);
    expect(output).toContain("no structured probe log");
  });

  test("fails on a denied log read instead of counting it clean", () => {
    const { exitCode, output } = privacy([
      {
        tool: "gcloud",
        pattern: '^logging read "synthetic-probe-marker"',
        exit: 1,
      },
    ]);
    expect(exitCode).toBe(1);
    expect(output).toContain("marker absence in logs unverified");
  });

  test("sends no marker while any sink could receive token-route logs", () => {
    for (const override of [
      {
        tool: "gcloud",
        pattern: "^logging sinks list --project=",
        stdout: JSON.stringify([
          ...projectSinks,
          { name: "export", destination: "bigquery.googleapis.com/x" },
        ]),
      },
      {
        tool: "gcloud",
        pattern: "^logging sinks list --folder=4242",
        stdout: JSON.stringify([
          {
            name: "org-export",
            destination: "storage.googleapis.com/y",
            includeChildren: true,
          },
        ]),
      },
      { tool: "gcloud", pattern: "^logging sinks list --folder=4242", exit: 1 },
      { tool: "gcloud", pattern: "^projects get-ancestors", exit: 1 },
      {
        tool: "curl",
        pattern: "logging\\.googleapis\\.com/v2/projects/.*/exclusions",
        stdout: JSON.stringify({
          exclusions: [
            { name: exclusionName, filter: exclusionFilter, disabled: true },
          ],
        }),
      },
    ] satisfies ReadonlyArray<FakeRule>) {
      const { exitCode, markerSent } = privacy([override]);
      expect({ override, exitCode, markerSent }).toEqual({
        override,
        exitCode: 1,
        markerSent: false,
      });
    }
  });

  test("sends no marker unless the live exclusion is the full Terraform filter", () => {
    const liveExclusion = (filter: string): FakeRule => ({
      tool: "curl",
      pattern: "logging\\.googleapis\\.com/v2/projects/.*/exclusions",
      stdout: JSON.stringify({ exclusions: [{ name: exclusionName, filter }] }),
    });
    const withoutCloudRun = `${lbSource} AND httpRequest.requestUrl=~"^https?://[^/]+(${routes})([/?#]|$)"`;
    const withoutRoute = exclusionFilter.replace("/app/auth/callback|", "");
    for (const [overrides, recorded] of [
      // No filter recorded by the edge apply.
      [[], null],
      // The live exclusion differs from what Terraform applied.
      [[liveExclusion(withoutCloudRun)], exclusionFilter],
      // Terraform's own filter misses Cloud Run request logs or a route.
      [[liveExclusion(withoutCloudRun)], withoutCloudRun],
      [[liveExclusion(withoutRoute)], withoutRoute],
    ] satisfies ReadonlyArray<[ReadonlyArray<FakeRule>, string | null]>) {
      const { exitCode, markerSent } = privacy(overrides, recorded);
      expect({ recorded, exitCode, markerSent }).toEqual({
        recorded,
        exitCode: 1,
        markerSent: false,
      });
    }
  });

  test("accepts an inherited sink that excludes the same filter", () => {
    const { exitCode, output } = privacy([
      {
        tool: "gcloud",
        pattern: "^logging sinks list --folder=4242",
        stdout: JSON.stringify([
          {
            name: "org-export",
            destination: "storage.googleapis.com/y",
            includeChildren: true,
            exclusions: [{ name: "tokens", filter: exclusionFilter }],
          },
        ]),
      },
    ]);
    expect({ exitCode, output: exitCode === 0 ? "" : output }).toEqual({
      exitCode: 0,
      output: "",
    });
  });
});
