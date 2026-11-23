import { describe, expect, test } from "bun:test";
import { GcpEnvironment } from "@alchemy.run/gcp";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import { sandboxConfig } from "./config/stack-config.test-utils";
import { verifyStackTarget } from "./stack-target";

const check = (stage: string, project: string) =>
  Effect.runSyncExit(
    verifyStackTarget(sandboxConfig).pipe(
      Effect.provideService(Stage, stage),
      Effect.provideService(
        GcpEnvironment,
        Effect.succeed({
          project,
          region: "europe-west1",
          // Never read by the check; synthetic.
          accessToken: Redacted.make("synthetic-access-token"),
        })
      )
    )
  );

describe("stack target", () => {
  test("accepts the configured stage and effective project", () => {
    expect(Exit.isSuccess(check("sandbox", "deskohub-ws-sandbox"))).toBe(true);
  });

  test("refuses another stage or another effective project", () => {
    for (const [stage, project] of [
      ["production", "deskohub-ws-sandbox"],
      ["sandbox", "deskohub-ws-production"],
    ] as const) {
      expect(Exit.isFailure(check(stage, project))).toBe(true);
    }
  });
});
