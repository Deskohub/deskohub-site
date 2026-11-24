import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Schema from "effect/Schema";
import { tokenRouteExclusionFilter } from "./resources/edge-declarations";
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
  GOOGLE_ACCESS_TOKEN_EXPIRES_AT: "99999999999",
};

const runPhase = (
  fakes: ProofFakes,
  phase: string | ReadonlyArray<string>,
  env: Record<string, string> = {}
) => {
  const result = Bun.spawnSync(["bash", runner, ...[phase].flat()], {
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

const settled = (digest?: string) => {
  const record = { generation: 3, writer: null, pendingApply: null };
  return {
    version: "1",
    record:
      digest === undefined
        ? record
        : {
            ...record,
            active: { imageDigest: digest, releaseId: "release-3" },
          },
  };
};

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
        seed(fakes, { "stack-config.json": "{}" });
        if (deadHolder !== null) {
          seed(fakes, { "interrupted-dead-holder": `${deadHolder}\n` });
        }
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

describe("release command output", () => {
  const v1Digest = `sha256:${"1".repeat(64)}`;
  // What Alchemy's GCP auth logged before the JSON in run 45279064237.
  const alchemyLog =
    "[22:30:23.620] INFO (#12): GCP: using environment variables (GOOGLE_ACCESS_TOKEN, GOOGLE_PROJECT_ID).";
  const status = (
    record: Schema.JsonObject,
    logs: "stdout" | "stderr"
  ): FakeRule => ({
    tool: "bun",
    pattern: "^release\\.run\\.ts status",
    ...(logs === "stdout"
      ? { stdout: `${alchemyLog}\n${JSON.stringify(record)}` }
      : { stdout: JSON.stringify(record), stderr: alchemyLog }),
  });
  const plan = (summary: string): FakeRule => ({
    tool: "bun",
    pattern: "^release\\.run\\.ts plan",
    stderr: `${alchemyLog}\nPlan: ${summary}`,
  });
  const deliverV1 = (rules: ReadonlyArray<FakeRule>) =>
    withProofFakes({ rules }, (fakes) => {
      seed(fakes, { "digests.env": `PROBE_V1_DIGEST=${v1Digest}\n` });
      return runPhase(fakes, "deliver-v1");
    });

  test("reads a status whose logs went to stderr and a plan printed there", () => {
    const { exitCode, output } = deliverV1([
      status(settled(v1Digest), "stderr"),
      plan("no changes"),
    ]);
    expect({ exitCode, output: exitCode === 0 ? "" : output }).toEqual({
      exitCode: 0,
      output: "",
    });
    expect(
      deliverV1([status(settled(v1Digest), "stderr"), plan("1 to update")])
        .exitCode
    ).toBe(1);
  });

  test("fails clearly when a log reaches the status JSON on stdout", () => {
    const { exitCode, output } = deliverV1([
      status(settled(v1Digest), "stdout"),
      plan("no changes"),
    ]);
    expect(exitCode).toBe(1);
    expect(output).toContain("printed no single JSON record");
    expect(output).not.toContain("writer lock: expected");
  });

  test("tears down under the lock even when the status is unreadable", () => {
    withProofFakes({ rules: [status(settled(), "stdout")] }, (fakes) => {
      const { exitCode, output } = runPhase(fakes, "stack-destroy");
      expect({ exitCode, output: exitCode === 0 ? "" : output }).toEqual({
        exitCode: 0,
        output: "",
      });
      const calls = fakes.calls();
      expect(calls).toContain("bun scripts/sandbox-locked-stack.ts destroy");
      expect(calls.some((call) => call.includes("release.run.ts unlock"))).toBe(
        false
      );
    });
  });
});

describe("drift detection", () => {
  const injected = "sandbox proof drift 111";
  const declared = "Workspace container images, deployed by digest.";
  // The fake repository keeps the injected description until a repair.
  const driftWith = (driftExit: number) =>
    withProofFakes(
      {
        rules: [
          {
            tool: "bun",
            pattern: "^scripts/sandbox-locked-stack\\.ts drift",
            exit: driftExit,
          },
          {
            tool: "bun",
            pattern: "^scripts/sandbox-locked-stack\\.ts repair",
            set: { repositoryDescription: declared },
          },
          {
            tool: "bun",
            pattern: "^release\\.run\\.ts plan",
            stderr: "Plan: no changes",
          },
        ],
      },
      (fakes) => {
        seed(fakes, { "stack-config.json": "{}" });
        const { exitCode, output } = runPhase(fakes, "drift");
        return { exitCode, output, calls: fakes.calls() };
      }
    );

  test("repairs once Alchemy reports the injected drift", () => {
    const { exitCode, output, calls } = driftWith(2);
    expect(calls).toContain(
      `gcloud artifacts repositories update workspace --project=deskohub-workspace-sandbox --location=europe-west1 --description=${injected}`
    );
    expect({ exitCode, output: exitCode === 0 ? "" : output }).toEqual({
      exitCode: 0,
      output: "",
    });
    expect(calls).toContain("bun scripts/sandbox-locked-stack.ts repair");
  });

  test("fails as a failed check, not as no drift, when Alchemy errors", () => {
    const { exitCode, output, calls } = driftWith(1);
    expect(exitCode).toBe(1);
    expect(output).toContain("drift check failed (exit 1)");
    expect(output).not.toContain("reported no drift");
    expect(calls).not.toContain("bun scripts/sandbox-locked-stack.ts repair");
  });

  test("fails when Alchemy finds a clean stage after the injection", () => {
    const { exitCode, output, calls } = driftWith(0);
    expect(exitCode).toBe(1);
    expect(output).toContain("reported no drift");
    expect(calls).not.toContain("bun scripts/sandbox-locked-stack.ts repair");
  });
});

// One page of a parent's sinks as the Logging API lists them; a later
// page is the one asked for by the earlier page's token.
const sinksPage = (
  parent: string,
  sinks: ReadonlyArray<Schema.JsonObject>,
  page: { readonly token?: string; readonly next?: string } = {}
): FakeRule => ({
  tool: "curl",
  pattern: `logging\\.googleapis\\.com/v2/${parent}/sinks\\?pageSize=100${
    page.token === undefined ? "" : `&pageToken=${page.token}`
  }$`,
  stdout: JSON.stringify(
    page.next === undefined ? { sinks } : { sinks, nextPageToken: page.next }
  ),
});
describe("read-only inventory", () => {
  test("reports the project's log sinks from every page", () => {
    const { exitCode, output } = withProofFakes(
      {
        rules: [
          sinksPage(
            `projects/${projectId}`,
            [
              {
                name: "export",
                destination: "bigquery.googleapis.com/x",
                filter: "severity>=ERROR",
              },
            ],
            { token: "page-2" }
          ),
          sinksPage(
            `projects/${projectId}`,
            [{ name: "_Default", destination: "logging/_Default" }],
            { next: "page-2" }
          ),
        ],
      },
      (fakes) => runPhase(fakes, "readonly-inventory")
    );
    expect({
      exitCode,
      sinks: output
        .split("\n")
        .filter((line) => /^(_Default|export)\t/.test(line)),
    }).toEqual({
      exitCode: 0,
      sinks: [
        "_Default\tlogging/_Default\t(empty filter)",
        "export\tbigquery.googleapis.com/x\tseverity>=ERROR",
      ],
    });
  });
});

describe("post-destroy inventory", () => {
  const state = `gs://${stateBucket}`;
  // `storage ls -r` once the stack is gone: folder headings, the
  // Alchemy lease and nothing else.
  const emptiedState = [
    `${state}/:`,
    "",
    `${state}/DeskohubWorkspace/:`,
    "",
    `${state}/${stackPrefix}:`,
    `${state}/${lease}`,
  ].join("\n");
  const inventory = (rules: ReadonlyArray<FakeRule>) =>
    withProofFakes({ rules }, (fakes) =>
      runPhase(fakes, "post-destroy-inventory")
    );
  const listing = (pattern: string, stdout: string): FakeRule => ({
    tool: "gcloud",
    pattern,
    stdout,
  });

  test("lists the project's log sinks from every page", () => {
    const listed = withProofFakes(
      {
        rules: [
          listing("^storage ls -r", emptiedState),
          sinksPage(
            `projects/${projectId}`,
            [{ name: "export", destination: "bigquery.googleapis.com/x" }],
            { token: "page-2" }
          ),
          sinksPage(
            `projects/${projectId}`,
            [{ name: "_Default", destination: "logging/_Default" }],
            { next: "page-2" }
          ),
        ],
      },
      (fakes) => {
        const { exitCode } = runPhase(fakes, "post-destroy-inventory");
        const file = join(
          fakes.proofDir,
          "inventory-post-destroy",
          "logging-sinks.txt"
        );
        return {
          exitCode,
          sinks: existsSync(file) ? readFileSync(file, "utf8") : null,
        };
      }
    );
    expect(listed).toEqual({
      exitCode: 0,
      sinks: "_Default\tlogging/_Default\nexport\tbigquery.googleapis.com/x\n",
    });
  });

  test("counts folder headings and the lease as no residue", () => {
    const { exitCode, output } = inventory([
      listing("^storage ls -r", emptiedState),
    ]);
    expect({ exitCode, output: exitCode === 0 ? "" : output }).toEqual({
      exitCode: 0,
      output: "",
    });
  });

  test("finds leftover state objects, queues and jobs by their bare IDs", () => {
    for (const leftover of [
      listing(
        "^storage ls -r",
        `${emptiedState}\n${state}/${stackPrefix}WorkspaceWeb.json`
      ),
      listing(
        "^storage ls -r",
        `${emptiedState}\n${state}/sandbox-proof/run.env`
      ),
      // The live release record a failed removal left.
      listing(
        "^storage ls -r",
        `${emptiedState}\n${state}/workspace-release-record.sandbox.json`
      ),
      listing(
        "^tasks queues list",
        "workspace-paid-fulfillment-r45279064237-1"
      ),
      listing("^scheduler jobs list", "workspace-reservation-hold-sweep"),
      listing("^artifacts repositories list", "workspace"),
    ]) {
      const { exitCode, output } = inventory([
        leftover,
        listing("^storage ls -r", emptiedState),
      ]);
      expect({ leftover, exitCode }).toEqual({ leftover, exitCode: 1 });
      expect(output).toContain("proof resources remain");
    }
  });
});

describe("cleanup-only after run 45279064237", () => {
  test("tears down that run's stack with its recorded queues", () => {
    withProofFakes(
      {
        // What run 45279064237 left: its proof run record and a settled
        // release record with no writer lock.
        files: { "sandbox-proof/run.env": "QUEUE_SUFFIX=r45279064237-1\n" },
        status: settled(`sha256:${"2".repeat(64)}`),
        rules: [
          {
            tool: "gcloud",
            pattern: "^projects describe",
            stdout: "759037106024",
          },
          {
            tool: "gcloud",
            pattern: "^storage buckets describe",
            stdout: "EUROPE-WEST1",
          },
          {
            tool: "gcloud",
            pattern: "^storage ls -r",
            stdout: `gs://${stateBucket}/${stackPrefix}:\ngs://${stateBucket}/${lease}`,
          },
        ],
      },
      (fakes) => {
        const env = { SANDBOX_PROOF_MODE: "cleanup-only" };
        const preflight = runPhase(fakes, "preflight", env);
        expect(preflight.exitCode).toBe(0);
        const config = readFileSync(
          join(fakes.proofDir, "stack-config.json"),
          "utf8"
        );
        expect(config).toContain('"disposableQueueSuffix":"r45279064237-1"');
        const { exitCode, output } = runPhase(fakes, "cleanup-only", env);
        expect({ exitCode, output: exitCode === 0 ? "" : output }).toEqual({
          exitCode: 0,
          output: "",
        });
        const calls = fakes.calls();
        const destroy = calls.indexOf(
          "bun scripts/sandbox-locked-stack.ts destroy"
        );
        const removals = calls.flatMap((call, index) =>
          /^gcloud storage rm /.test(call) ? [index] : []
        );
        expect(destroy).toBeGreaterThan(-1);
        expect(removals.length).toBe(2);
        expect(removals.every((index) => index > destroy)).toBe(true);
        expect(fakes.world().files?.["sandbox-proof/run.env"]).toBeUndefined();
      }
    );
  }, 60_000);
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
  /** The disposable queue suffix the stack config the runner wrote declares. */
  const queueSuffixOf = (fakes: ProofFakes) =>
    Schema.decodeSync(
      Schema.fromJsonString(
        Schema.Struct({
          disposableQueueSuffix: Schema.optionalKey(Schema.String),
        })
      )
    )(readFileSync(join(fakes.proofDir, "stack-config.json"), "utf8"))
      .disposableQueueSuffix;

  const foundation = (runId: string) =>
    withProofFakes({}, (fakes) => {
      const { exitCode, output } = runPhase(fakes, "foundation", {
        GITHUB_RUN_ID: runId,
        GITHUB_RUN_ATTEMPT: "2",
      });
      return {
        exitCode,
        output,
        suffix: queueSuffixOf(fakes),
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
        expect(queueSuffixOf(fakes)).toBe("r111-2");
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
  const manifest = (fakes: ProofFakes, file: string): unknown =>
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

  test("fails on an unreadable object instead of leaving it out", () => {
    // A credential error worded like a missing object, on a live object.
    const credentialError: FakeRule = {
      tool: "curl",
      pattern: "storage\\.googleapis\\.com/storage/v1/b/.*Queue\\.json",
      stdout:
        '{"error":{"code":401,"message":"credential file not found"}}\n401',
    };
    withProofFakes({ ...stateWorld(), rules: [credentialError] }, (fakes) => {
      const snapshot = runPhase(fakes, "state-snapshot-locked", locked);
      expect(snapshot.exitCode).toBe(1);
      expect(snapshot.output).toContain("Queue.json is unreadable");

      seed(fakes, {
        "state-snapshot.json": JSON.stringify([
          {
            name: `${stackPrefix}Service.json`,
            generation: "3",
            crc32c: "crc-service-3",
          },
        ]),
      });
      const restore = runPhase(fakes, "state-restore-locked", locked);
      expect(restore.exitCode).toBe(1);
      expect(restore.output).toContain("Queue.json is unreadable");
      const writes = fakes
        .calls()
        .filter((call) => /^gcloud storage (cp|rm) /.test(call));
      expect(writes).toEqual([]);
      expect(fakes.world().objects?.[`${stackPrefix}Queue.json`]?.live).toBe(
        "7"
      );
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
      const [first, ...rest] = Schema.decodeUnknownSync(
        Schema.Array(Schema.Record(Schema.String, Schema.Unknown))
      )(manifest(fakes, "state-live.json"));
      if (first === undefined) {
        throw new Error("expected the snapshot to list an object");
      }
      const altered = [{ ...first, crc32c: "crc-never-written" }, ...rest];
      seed(fakes, { "state-snapshot.json": JSON.stringify(altered) });
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

describe("Alchemy access token", () => {
  // Every Alchemy phase must start with the stack destroy's 30-minute
  // budget left on the token it hands Alchemy.
  const now = 1_800_000_000;
  const lifetime = (seconds: number): FakeRule => ({
    tool: "curl",
    pattern: "oauth2\\.googleapis\\.com/tokeninfo",
    stdout: JSON.stringify({ expires_in: String(seconds) }),
  });
  const run = (
    phases: string | ReadonlyArray<string>,
    expiresIn: number,
    rules: ReadonlyArray<FakeRule> = [lifetime(3599)]
  ) =>
    withProofFakes({ now, rules }, (fakes) => {
      const result = runPhase(fakes, phases, {
        GOOGLE_ACCESS_TOKEN_EXPIRES_AT: String(now + expiresIn),
      });
      return {
        ...result,
        // A minted token is masked before any use.
        mints: result.output.split("::add-mask::").length - 1,
        calls: fakes.calls(),
      };
    });

  test("mints a fresh token once under 30 minutes remain", () => {
    for (const [left, mints] of [
      [1800, 0],
      [1799, 1],
    ] as const) {
      const result = run("foundation", left);
      expect({ left, exitCode: result.exitCode, mints: result.mints }).toEqual({
        left,
        exitCode: 0,
        mints,
      });
    }
  });

  test("verifies the workflow's token by its own remaining lifetime", () => {
    // However long ago the auth step minted it, only tokeninfo decides.
    for (const [left, mints] of [
      [3000, 0],
      [1790, 1],
      [undefined, 1],
    ] as const) {
      const { exitCode, output } = withProofFakes(
        {
          now,
          tokenLifetimes:
            left === undefined
              ? { "fake-access-token": 3599 }
              : { "fake-access-token": 3599, "workflow-token": left },
        },
        (fakes) =>
          runPhase(fakes, "foundation", {
            GOOGLE_ACCESS_TOKEN: "workflow-token",
            GOOGLE_ACCESS_TOKEN_EXPIRES_AT: "",
          })
      );
      expect({
        left,
        exitCode,
        mints: output.split("::add-mask::").length - 1,
      }).toEqual({ left, exitCode: 0, mints });
    }
  });

  test("counts a slow tokeninfo reply against the token", () => {
    // Each reply takes 5 s, so a reported 1801 s or 1803 s leaves less
    // than 30 minutes once it arrives.
    const withLifetimes = (lifetimes: Record<string, number>) =>
      withProofFakes(
        { now, tokenLifetimes: lifetimes, tokeninfoDelay: 5 },
        (fakes) => {
          const result = runPhase(fakes, "foundation", {
            GOOGLE_ACCESS_TOKEN: "workflow-token",
            GOOGLE_ACCESS_TOKEN_EXPIRES_AT: "",
          });
          return {
            exitCode: result.exitCode,
            mints: result.output.split("::add-mask::").length - 1,
          };
        }
      );
    // The workflow's token is replaced, and the fresh one accepted.
    expect(
      withLifetimes({ "workflow-token": 1801, "fake-access-token": 3599 })
    ).toEqual({ exitCode: 0, mints: 1 });
    // A fresh token short of 30 minutes on arrival is refused.
    expect(withLifetimes({ "fake-access-token": 1803 })).toEqual({
      exitCode: 1,
      mints: 1,
    });
  });

  test("refreshes between phases of one run by the token's real expiry", () => {
    // The minted token has 1805 s; the first deploy takes 600 s of it.
    const { exitCode, mints } = run(["foundation", "foundation"], 0, [
      lifetime(1805),
      { tool: "bun", pattern: "^release\\.run\\.ts deploy", advance: 600 },
    ]);
    expect({ exitCode, mints }).toEqual({ exitCode: 0, mints: 2 });
  });

  test("refuses a token with less than 30 minutes left", () => {
    for (const rules of [[lifetime(600)], []]) {
      const { exitCode, output, calls } = run("foundation", 0, rules);
      expect({
        exitCode,
        refused: output.includes("access token"),
        deployed: calls.some((call) => call.includes("release.run.ts deploy")),
      }).toEqual({ exitCode: 1, refused: true, deployed: false });
    }
  });

  test("takes the inventories even when no token can be verified", () => {
    for (const phase of ["baseline-inventory", "post-destroy-inventory"]) {
      const { exitCode, mints, calls } = run(phase, 0, []);
      expect({
        phase,
        exitCode,
        mints,
        listed: calls.includes(
          "gcloud run services list --project=deskohub-workspace-sandbox --region=europe-west1 --format=value(metadata.name)"
        ),
      }).toEqual({ phase, exitCode: 0, mints: 0, listed: true });
    }
  });
});

describe("edge readback from the live edge", () => {
  // Each readback runs the real stack config and edge declaration scripts.
  const readbackTimeout = 60_000;
  const policy = "workspace-sandbox-edge";
  const edgeIp = "203.0.113.7";
  const compute = `https://www.googleapis.com/compute/v1/projects/${projectId}/global`;
  const edgeOutputs = {
    edgeIpAddress: edgeIp,
    edgeProtocol: "http",
    securityPolicy: policy,
    backendServices: {
      dynamic: "workspace-sandbox-dynamic",
      static: "workspace-sandbox-static",
    },
    tokenRouteExclusionFilter,
  };
  const policyLink = `${compute}/securityPolicies/${policy}`;
  const waf = (priority: number, set: string) => ({
    priority,
    action: "deny(403)",
    preview: true,
    match: {
      expr: {
        expression: `evaluatePreconfiguredWaf('${set}-v33-stable', {'sensitivity': 1})`,
      },
    },
  });
  const throttle = {
    priority: 2000,
    action: "throttle",
    match: { expr: { expression: "request.path.startsWith('/api/auth/')" } },
    rateLimitOptions: {
      conformAction: "allow",
      exceedAction: "deny(429)",
      enforceOnKey: "IP",
      rateLimitThreshold: { count: 120, intervalSec: 60 },
    },
  };
  const defaultRule = {
    priority: 2147483647,
    action: "allow",
    match: { versionedExpr: "SRC_IPS_V1", config: { srcIpRanges: ["*"] } },
  };
  const withDefault = (changes: Schema.JsonObject) =>
    policyRules.map((rule) =>
      rule.priority === 2147483647 ? { ...defaultRule, ...changes } : rule
    );
  // As Compute returns the sandbox policy the stack declares.
  const policyRules = [
    waf(1000, "sqli"),
    waf(1010, "xss"),
    throttle,
    defaultRule,
  ];
  // The policy as Compute returns it, `preview: false` omitted as Compute
  // omits it.
  const policyResource = (rules: ReadonlyArray<Schema.JsonObject>) => ({
    kind: "compute#securityPolicy",
    id: "4815162342",
    name: policy,
    type: "CLOUD_ARMOR",
    fingerprint: "c2FuZGJveA==",
    selfLink: policyLink,
    rules: rules.map((rule) => ({
      kind: "compute#securityPolicyRule",
      ...rule,
    })),
  });
  // `security-policies describe --format=json` as Google Cloud SDK 594.0.1
  // prints it: the describe request's one-element result list, as run
  // 45305300114 read it.
  const policyDescription = (rules: ReadonlyArray<Schema.JsonObject>) =>
    JSON.stringify([policyResource(rules)]);
  const withThrottle = (changes: Schema.JsonObject) =>
    policyRules.map((rule) =>
      rule.priority === 2000 ? { ...throttle, ...changes } : rule
    );
  const forwardingRule = (changes: Schema.JsonObject = {}): FakeRule => ({
    tool: "gcloud",
    pattern: "^compute forwarding-rules describe workspace-sandbox-http ",
    stdout: JSON.stringify({
      IPAddress: edgeIp,
      portRange: "80-80",
      target: `${compute}/targetHttpProxies/workspace-sandbox-edge-http`,
      ...changes,
    }),
  });
  // The edge as Compute describes it after deliver-v1.
  const liveEdge = (
    overrides: ReadonlyArray<FakeRule> = []
  ): ReadonlyArray<FakeRule> => [
    ...overrides,
    {
      tool: "gcloud",
      pattern: "^compute addresses describe workspace-sandbox-edge ",
      stdout: edgeIp,
    },
    forwardingRule(),
    {
      tool: "gcloud",
      pattern:
        "^compute target-http-proxies describe workspace-sandbox-edge-http ",
      stdout: `${compute}/urlMaps/workspace-sandbox-edge`,
    },
    {
      tool: "gcloud",
      pattern: "^compute backend-services describe workspace-sandbox-",
      stdout: policyLink,
    },
    {
      tool: "gcloud",
      pattern: `^compute security-policies describe ${policy} .*--format=json$`,
      stdout: policyDescription(policyRules),
    },
    {
      tool: "curl",
      pattern: "http://203\\.0\\.113\\.7/healthz$",
      stdout: JSON.stringify({ status: "ok", version: "v1" }),
    },
    {
      tool: "curl",
      pattern: "http://203\\.0\\.113\\.7/robots\\.txt$",
      stdout: "text/plain; charset=utf-8",
    },
  ];
  const readback = (overrides: ReadonlyArray<FakeRule> = []) =>
    withProofFakes({ rules: liveEdge(overrides) }, (fakes) => {
      const result = runPhase(fakes, "edge-readback");
      const read = (name: string) =>
        existsSync(join(fakes.proofDir, name))
          ? readFileSync(join(fakes.proofDir, name), "utf8")
          : null;
      return {
        ...result,
        edgeEnv: read("edge.env"),
        filter: read("edge-exclusion-filter.txt"),
        kept: read("edge-outputs.json"),
        calls: fakes.calls(),
      };
    });

  test(
    "reads the declared edge back live and checks v1 through it",
    () => {
      const { exitCode, output, edgeEnv, filter, kept, calls } = readback();
      expect({ exitCode, output: exitCode === 0 ? "" : output }).toEqual({
        exitCode: 0,
        output: "",
      });
      expect(edgeEnv).toBe(`EDGE_IP=${edgeIp}\n`);
      // Byte for byte the declared filter the privacy phase compares the
      // live exclusion to.
      expect(filter).toBe(tokenRouteExclusionFilter);
      expect(JSON.parse(kept ?? "null")).toEqual(edgeOutputs);
      expect(calls).toContain(
        `gcloud compute addresses describe workspace-sandbox-edge --project=${projectId} --global --format=value(address)`
      );
      // The live state holds no stack outputs object, so none is read; reading
      // back writes nothing: no deploy, destroy or upload.
      expect(
        calls.filter((call) =>
          /storage cat|release\.run\.ts (deliver|deploy)|sandbox-locked-stack|storage (cp|rm)/.test(
            call
          )
        )
      ).toEqual([]);
    },
    readbackTimeout
  );

  test(
    "fails when the declared edge address is missing or holds no IP",
    () => {
      for (const address of [{ exit: 1 }, { stdout: "" }]) {
        const { exitCode, edgeEnv, calls } = readback([
          {
            tool: "gcloud",
            pattern: "^compute addresses describe workspace-sandbox-edge ",
            ...address,
          },
        ]);
        expect({ address, exitCode, edgeEnv }).toEqual({
          address,
          exitCode: 1,
          edgeEnv: null,
        });
        expect(calls.some((call) => call.startsWith("curl"))).toBe(false);
      }
    },
    readbackTimeout
  );

  test(
    "fails unless the HTTP forwarding rule fronts the address through the declared proxy and URL map",
    () => {
      for (const override of [
        forwardingRule({ IPAddress: "198.51.100.99" }),
        forwardingRule({ portRange: "443-443" }),
        forwardingRule({ portRange: "80-81" }),
        forwardingRule({ target: `${compute}/targetHttpProxies/other` }),
        { ...forwardingRule(), stdout: undefined, exit: 1 },
        {
          tool: "gcloud",
          pattern: "^compute target-http-proxies describe ",
          stdout: `${compute}/urlMaps/other`,
        },
      ]) {
        const { exitCode, edgeEnv, calls } = readback([override]);
        expect({ override, exitCode, edgeEnv }).toEqual({
          override,
          exitCode: 1,
          edgeEnv: null,
        });
        expect(calls.some((call) => call.startsWith("curl"))).toBe(false);
      }
    },
    readbackTimeout
  );

  test(
    "reads the policy from the one-element list or a bare object, never from no or several policies",
    () => {
      const described = (stdout: string): FakeRule => ({
        tool: "gcloud",
        pattern: "^compute security-policies describe .*--format=json$",
        stdout,
      });
      const bare = readback([
        described(JSON.stringify(policyResource(policyRules))),
      ]);
      expect({
        exitCode: bare.exitCode,
        output: bare.exitCode === 0 ? "" : bare.output,
      }).toEqual({ exitCode: 0, output: "" });
      for (const stdout of [
        "[]",
        JSON.stringify([
          policyResource(policyRules),
          policyResource(policyRules),
        ]),
        "[null]",
      ]) {
        const { exitCode, calls } = readback([described(stdout)]);
        expect({ stdout, exitCode }).toEqual({ stdout, exitCode: 1 });
        expect(calls.some((call) => call.startsWith("curl"))).toBe(false);
      }
    },
    readbackTimeout
  );

  test(
    "names each rule that differs from the declaration",
    () => {
      const { exitCode, output } = readback([
        {
          tool: "gcloud",
          pattern: "^compute security-policies describe .*--format=json$",
          stdout: policyDescription(
            withThrottle({ preview: true }).map((rule) =>
              rule.priority === 1010 ? { ...rule, preview: false } : rule
            )
          ),
        },
      ]);
      const error =
        output.split("\n").find((line) => line.startsWith("::error::")) ?? "";
      expect(exitCode).toBe(1);
      expect(
        ["1000", "1010", "2000", "2147483647"].filter((priority) =>
          new RegExp(`\\b${priority}\\b`).test(error)
        )
      ).toEqual(["1010", "2000"]);
    },
    readbackTimeout
  );

  test(
    "fails unless both backends enforce the policy as declared",
    () => {
      const detached: FakeRule = {
        tool: "gcloud",
        pattern: "^compute backend-services describe workspace-sandbox-static",
        stdout: "",
      };
      const unreadable: FakeRule = {
        tool: "gcloud",
        pattern: "^compute backend-services describe workspace-sandbox-dynamic",
        exit: 1,
      };
      const rules = (next: ReadonlyArray<Schema.JsonObject>): FakeRule => ({
        tool: "gcloud",
        pattern: "^compute security-policies describe .*--format=json$",
        stdout: policyDescription(next),
      });
      for (const override of [
        detached,
        unreadable,
        // A WAF rule enforced instead of previewed.
        rules(
          policyRules.map((rule) =>
            rule.priority === 1010 ? { ...rule, preview: false } : rule
          )
        ),
        // A WAF rule matching another rule set.
        rules(
          policyRules.map((rule) =>
            rule.priority === 1000 ? waf(1000, "lfi") : rule
          )
        ),
        // The auth throttle only previewed, on another route, at another
        // limit, or missing.
        rules(withThrottle({ preview: true })),
        rules(
          withThrottle({
            match: { expr: { expression: "request.path.startsWith('/x/')" } },
          })
        ),
        rules(
          withThrottle({
            rateLimitOptions: {
              ...throttle.rateLimitOptions,
              rateLimitThreshold: { count: 1000, intervalSec: 60 },
            },
          })
        ),
        rules(policyRules.filter((rule) => rule.priority !== 2000)),
        // The default rule denying, previewed, or matching only some sources.
        rules(withDefault({ action: "deny(403)" })),
        rules(withDefault({ preview: true })),
        rules(
          withDefault({
            match: {
              versionedExpr: "SRC_IPS_V1",
              config: { srcIpRanges: ["198.51.100.0/24"] },
            },
          })
        ),
      ]) {
        const { exitCode, calls } = readback([override]);
        expect({ override, exitCode }).toEqual({ override, exitCode: 1 });
        // No request is sent through an unverified edge.
        expect(calls.some((call) => call.startsWith("curl"))).toBe(false);
      }
    },
    readbackTimeout
  );
});

describe("token-route privacy and telemetry", () => {
  // A token-route exclusion filter as the stack's edge outputs it.
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
    sinksPage(`projects/${projectId}`, projectSinks),
    sinksPage("folders/4242", [
      { name: "_Default", destination: "logging/folder" },
    ]),
    // A warm instance: its startup export is older than every readback
    // window, so only a fresh export from the trace route verifies.
    {
      tool: "curl",
      pattern: "/healthz$",
      stdout: JSON.stringify({
        status: "ok",
        version: "v1",
        otlp: { traceId: "e".repeat(32), status: 200 },
      }),
    },
    {
      tool: "curl",
      pattern: "/probe/trace$",
      stdout: JSON.stringify({
        status: "ok",
        version: "v1",
        otlp: { traceId, status: 200 },
      }),
    },
    {
      tool: "gcloud",
      pattern:
        "^logging read .*jsonPayload\\.otlp\\.traceId.* --format=json\\(timestamp,jsonPayload\\.otlp\\)$",
      stdout: JSON.stringify([
        {
          timestamp: "2026-11-23T10:00:00Z",
          jsonPayload: { otlp: { traceId, status: 200 } },
        },
      ]),
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
      pattern:
        "^logging read .*run\\.googleapis\\.com/requests.* --format=json\\(logName,timestamp\\)$",
      stdout: JSON.stringify([
        {
          logName: `projects/${projectId}/logs/run.googleapis.com%2Frequests`,
          timestamp: "2026-11-23T10:01:00Z",
        },
      ]),
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
      seed(fakes, { "edge.env": "EDGE_IP=198.51.100.10\n" });
      if (recordedFilter !== null) {
        seed(fakes, { "edge-exclusion-filter.txt": recordedFilter });
      }
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

  test("reads every trace page with its page token URL-encoded", () => {
    const { exitCode, output } = privacy([
      {
        tool: "curl",
        pattern:
          "/traces\\?view=COMPLETE&pageSize=100&startTime=[^&]+&pageToken=a%2Bb%2Fc%3D$",
        stdout: JSON.stringify({ traces: [{ traceId }] }),
      },
      { tool: "curl", pattern: "/traces\\?.*&pageToken=", exit: 22 },
      {
        tool: "curl",
        pattern: "/traces\\?view=COMPLETE&pageSize=100&startTime=[^&]+$",
        stdout: JSON.stringify({
          traces: [{ traceId: "f".repeat(32) }],
          nextPageToken: "a+b/c=",
        }),
      },
    ]);
    expect({ exitCode, output: exitCode === 0 ? "" : output }).toEqual({
      exitCode: 0,
      output: "",
    });
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
    // No matching entry, or a read that prints nothing at all.
    for (const stdout of ["[]", ""]) {
      const { exitCode, output } = privacy([
        {
          tool: "gcloud",
          pattern: "^logging read .*jsonPayload\\.otlp\\.traceId",
          stdout,
        },
      ]);
      expect({ stdout, exitCode }).toEqual({ stdout, exitCode: 1 });
      expect(output).toContain("no structured probe log");
    }
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
      [
        sinksPage(`projects/${projectId}`, [
          ...projectSinks,
          { name: "export", destination: "bigquery.googleapis.com/x" },
        ]),
      ],
      [
        sinksPage("folders/4242", [
          {
            name: "org-export",
            destination: "storage.googleapis.com/y",
            includeChildren: true,
          },
        ]),
      ],
      [{ ...sinksPage("folders/4242", []), stdout: undefined, exit: 1 }],
      // An uncovered export on a later page of the project's or the
      // folder's sinks, which `gcloud logging sinks list` never reads.
      [
        sinksPage(
          `projects/${projectId}`,
          [{ name: "export", destination: "bigquery.googleapis.com/x" }],
          { token: "page-2" }
        ),
        sinksPage(`projects/${projectId}`, projectSinks, { next: "page-2" }),
      ],
      [
        sinksPage(
          "folders/4242",
          [
            {
              name: "org-export",
              destination: "storage.googleapis.com/y",
              includeChildren: true,
            },
          ],
          { token: "page%2B2" }
        ),
        sinksPage("folders/4242", [], { next: "page+2" }),
      ],
      // A later page answered with no body.
      [
        {
          ...sinksPage(`projects/${projectId}`, [], { token: "page-2" }),
          stdout: "",
        },
        sinksPage(`projects/${projectId}`, projectSinks, { next: "page-2" }),
      ],
      // Pages without end.
      [
        sinksPage("folders/4242", [], { token: "again", next: "again" }),
        sinksPage("folders/4242", [], { next: "again" }),
      ],
      [{ tool: "gcloud", pattern: "^projects get-ancestors", exit: 1 }],
      [
        {
          tool: "curl",
          pattern: "logging\\.googleapis\\.com/v2/projects/.*/exclusions",
          stdout: JSON.stringify({
            exclusions: [
              { name: exclusionName, filter: exclusionFilter, disabled: true },
            ],
          }),
        },
      ],
    ] satisfies ReadonlyArray<ReadonlyArray<FakeRule>>) {
      const { exitCode, markerSent } = privacy(override);
      expect({ override, exitCode, markerSent }).toEqual({
        override,
        exitCode: 1,
        markerSent: false,
      });
    }
  }, 60_000);

  test("sends no marker unless the live exclusion is the stack's full filter", () => {
    const liveExclusion = (filter: string): FakeRule => ({
      tool: "curl",
      pattern: "logging\\.googleapis\\.com/v2/projects/.*/exclusions",
      stdout: JSON.stringify({ exclusions: [{ name: exclusionName, filter }] }),
    });
    const withoutCloudRun = `${lbSource} AND httpRequest.requestUrl=~"^https?://[^/]+(${routes})([/?#]|$)"`;
    const withoutRoute = exclusionFilter.replace("/app/auth/callback|", "");
    for (const [overrides, recorded] of [
      // No filter recorded by the edge readback.
      [[], null],
      // The live exclusion differs from what the stack outputs.
      [[liveExclusion(withoutCloudRun)], exclusionFilter],
      // The stack's own filter misses Cloud Run request logs or a route.
      [[liveExclusion(withoutCloudRun)], withoutCloudRun],
      [[liveExclusion(withoutRoute)], withoutRoute],
      // Not byte for byte the recorded filter.
      [[liveExclusion(`${exclusionFilter}\n`)], exclusionFilter],
    ] satisfies ReadonlyArray<[ReadonlyArray<FakeRule>, string | null]>) {
      const { exitCode, markerSent } = privacy(overrides, recorded);
      expect({ recorded, exitCode, markerSent }).toEqual({
        recorded,
        exitCode: 1,
        markerSent: false,
      });
    }
  });

  test("sends the marker once every page of sinks, over 128 KiB, is covered", () => {
    // Sinks whose own filters are long, each excluding the token routes.
    const covered = (name: string) => ({
      name,
      destination: "storage.googleapis.com/y",
      filter: `logName:"${name}" OR ${"x".repeat(1600)}`,
      exclusions: [{ name: "tokens", filter: exclusionFilter }],
    });
    const firstPage = Array.from({ length: 95 }, (_, index) =>
      covered(`export-${index}`)
    );
    expect(JSON.stringify(firstPage).length).toBeGreaterThan(128 * 1024);
    const { exitCode, output, markerSent } = privacy([
      sinksPage(`projects/${projectId}`, [covered("export-late")], {
        token: "page-2",
      }),
      sinksPage(`projects/${projectId}`, [...projectSinks, ...firstPage], {
        next: "page-2",
      }),
    ]);
    expect({
      exitCode,
      output: exitCode === 0 ? "" : output,
      markerSent,
    }).toEqual({ exitCode: 0, output: "", markerSent: true });
  }, 60_000);

  test("accepts an inherited sink that excludes the same filter", () => {
    const { exitCode, output } = privacy([
      sinksPage("folders/4242", [
        {
          name: "org-export",
          destination: "storage.googleapis.com/y",
          includeChildren: true,
          exclusions: [{ name: "tokens", filter: exclusionFilter }],
        },
      ]),
    ]);
    expect({ exitCode, output: exitCode === 0 ? "" : output }).toEqual({
      exitCode: 0,
      output: "",
    });
  });
});
