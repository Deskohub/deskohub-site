import { describe, expect, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
  decodeWorkspaceStackConfig,
  GcpRegion,
  ImageDigest,
  serializeWorkspaceStackConfig,
  WorkspaceStackConfigInvalid,
} from "./stack-config";
import { sandboxConfig, sandboxConfigInput } from "./stack-config.test-utils";

const decodeFailure = (input: unknown) => {
  const exit = Effect.runSyncExit(decodeWorkspaceStackConfig(input));
  if (Exit.isSuccess(exit)) {
    throw new Error("expected the configuration to be rejected");
  }
  const error = exit.cause.reasons
    .map((reason) => (reason._tag === "Fail" ? reason.error : undefined))
    .find((candidate) => candidate instanceof WorkspaceStackConfigInvalid);
  if (error === undefined) {
    throw new Error("expected a WorkspaceStackConfigInvalid failure");
  }
  return error;
};

const fakePrivateKey =
  "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----";

describe("workspace stack configuration", () => {
  test("defaults the region to europe-west1", () => {
    expect(sandboxConfig.region).toBe(GcpRegion.make("europe-west1"));
    expect(sandboxConfig.stage).toBe("sandbox");
  });

  test("requires approved spend and teardown on a sandbox", () => {
    const { budget: _budget, ...withoutBudget } = sandboxConfigInput;
    expect(decodeFailure(withoutBudget).paths).toContain("budget");
  });

  test("rejects a secret value placed beside a reference", () => {
    const error = decodeFailure({
      ...sandboxConfigInput,
      secrets: [
        { ...sandboxConfigInput.secrets[0], value: "postgres-password-1" },
      ],
    });
    expect(error.reason).toBe("secret-material");
    expect(error.paths).toEqual(["secrets.0.value"]);
    expect(error.message).not.toContain("postgres-password-1");
  });

  test("rejects secret material under an allowed key without echoing it", () => {
    const leaked = "postgresql://workspace:s3cr3t-pass@db.internal/workspace";
    for (const [input, path] of [
      [{ ...sandboxConfigInput, stateBucket: leaked }, "stateBucket"],
      [
        {
          ...sandboxConfigInput,
          secrets: [
            { ...sandboxConfigInput.secrets[0], secretId: fakePrivateKey },
          ],
        },
        "secrets.0.secretId",
      ],
    ] as const) {
      const error = decodeFailure(input);
      expect(error.paths).toEqual([path]);
      expect(error.message).not.toContain("s3cr3t-pass");
      expect(error.message).not.toContain("PRIVATE KEY");
      expect(JSON.stringify(error)).not.toContain("s3cr3t-pass");
    }
  });

  test("rejects unknown keys and unpinned secret versions by path only", () => {
    const error = decodeFailure({
      ...sandboxConfigInput,
      extra: "unexpected",
      secrets: [{ ...sandboxConfigInput.secrets[0], version: "latest" }],
    });
    expect(error.reason).toBe("schema");
    expect(error.paths).toEqual(
      expect.arrayContaining(["extra", "secrets.0.version"])
    );
    expect(error.message).not.toContain("unexpected");
  });

  test("rejects a service account outside the naming rules", () => {
    expect(
      decodeFailure({
        ...sandboxConfigInput,
        serviceAccounts: {
          ...sandboxConfigInput.serviceAccounts,
          deployer: testEmailAddress("someone"),
        },
      }).paths
    ).toEqual(["serviceAccounts.deployer"]);
  });

  test("requires the project's own state bucket, which holds its one release lock", () => {
    expect(
      decodeFailure({
        ...sandboxConfigInput,
        stateBucket: "deskohub-ws-sandbox-other-state",
      })
    ).toMatchObject({ reason: "identity", paths: ["stateBucket"] });
  });

  test("requires a distinct service account per role in the stage's project", () => {
    const foreign = decodeFailure({
      ...sandboxConfigInput,
      serviceAccounts: {
        ...sandboxConfigInput.serviceAccounts,
        // A service account identifier in another project, not a mailbox.
        webRuntime: [
          "workspace-web",
          "deskohub-ws-production.iam.gserviceaccount.com",
        ].join("@"),
      },
    });
    expect(foreign).toMatchObject({
      reason: "identity",
      paths: ["serviceAccounts.webRuntime"],
    });
    const shared = decodeFailure({
      ...sandboxConfigInput,
      serviceAccounts: {
        ...sandboxConfigInput.serviceAccounts,
        tasksInvoker: sandboxConfigInput.serviceAccounts.schedulerInvoker,
      },
    });
    expect(shared.paths.toSorted()).toEqual([
      "serviceAccounts.schedulerInvoker",
      "serviceAccounts.tasksInvoker",
    ]);
  });

  test("serializes identifiers and pinned versions only", () => {
    const serialized = serializeWorkspaceStackConfig(sandboxConfig);
    expect(JSON.parse(serialized)).toMatchObject({
      region: "europe-west1",
      secrets: [
        {
          environmentVariable: "DATABASE_URL",
          secretId: "workspace-database-url",
          version: "3",
        },
      ],
    });
    expect(
      Effect.runSync(decodeWorkspaceStackConfig(JSON.parse(serialized)))
    ).toEqual(sandboxConfig);
  });

  test("takes an optional collector image pinned by digest only", () => {
    const collectorDigest = `sha256:${"c".repeat(64)}`;
    expect(sandboxConfig).not.toHaveProperty("telemetryCollectorImage");
    expect(serializeWorkspaceStackConfig(sandboxConfig)).not.toContain(
      "telemetryCollectorImage"
    );
    const withCollector = Effect.runSync(
      decodeWorkspaceStackConfig({
        ...sandboxConfigInput,
        telemetryCollectorImage: collectorDigest,
      })
    );
    expect(withCollector.telemetryCollectorImage).toBe(
      ImageDigest.make(collectorDigest)
    );
    expect(
      Effect.runSync(
        decodeWorkspaceStackConfig(
          JSON.parse(serializeWorkspaceStackConfig(withCollector))
        )
      )
    ).toEqual(withCollector);
    for (const rejected of [
      "otelcol-google:0.165.1",
      `europe-west1-docker.pkg.dev/p/workspace/collector@${collectorDigest}`,
      "sha256:abc",
    ]) {
      expect(
        decodeFailure({
          ...sandboxConfigInput,
          telemetryCollectorImage: rejected,
        }).paths
      ).toEqual(["telemetryCollectorImage"]);
    }
  });
});
