import { describe, expect, test } from "bun:test";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import {
  productionConfig,
  sandboxConfig,
} from "../config/stack-config.test-utils";
import {
  alchemyDeployCommand,
  commandServiceApply,
  releaseApplyGenerationVariable,
} from "./alchemy-service-apply";
import { ReleaseServiceApply } from "./release-platform";

const applyWith = (
  command: (generation: number) => ChildProcess.Command,
  generation: number
) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const platform = yield* ReleaseServiceApply;
      yield* platform.apply(generation);
    }).pipe(
      Effect.provide(
        commandServiceApply(command).pipe(Layer.provide(BunServices.layer))
      )
    )
  );

/** Exits 0 only when the apply received exactly the fenced generation. */
const generationProbe = (generation: number) =>
  ChildProcess.make(
    process.execPath,
    [
      "-e",
      `process.exit(process.env.${releaseApplyGenerationVariable} === "7" ? 0 : 3)`,
    ],
    {
      env: { [releaseApplyGenerationVariable]: String(generation) },
      extendEnv: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }
  );

describe("alchemy service apply", () => {
  test("deploys the config's own stage fenced to one generation", () => {
    for (const config of [sandboxConfig, productionConfig]) {
      const command = alchemyDeployCommand(config, 12);
      expect(command._tag).toBe("StandardCommand");
      if (command._tag !== "StandardCommand") {
        continue;
      }
      expect([command.command, ...command.args]).toEqual([
        "bun",
        "x",
        "alchemy",
        "deploy",
        "alchemy.run.ts",
        "--stage",
        config.stage,
        "--yes",
        "--no-input",
      ]);
      expect(command.options.env).toEqual({
        [releaseApplyGenerationVariable]: "12",
      });
      // The stack config and credentials come from the caller's environment.
      expect(command.options.extendEnv).toBe(true);
      expect(command.options.cwd?.endsWith("workspace-infrastructure/")).toBe(
        true
      );
    }
  });

  test("a zero exit applies and any other exit fails the generation", async () => {
    expect(Exit.isSuccess(await applyWith(generationProbe, 7))).toBe(true);

    const failed = await applyWith(generationProbe, 8);
    expect(Exit.isFailure(failed)).toBe(true);
    if (Exit.isFailure(failed)) {
      const reason = failed.cause.reasons[0];
      expect(reason?._tag === "Fail" ? reason.error : reason).toMatchObject({
        _tag: "ReleaseServiceApplyFailed",
        generation: 8,
        reason: "The apply exited with code 3",
      });
    }
  });

  test("a command that cannot start fails the generation", async () => {
    const missing = await applyWith(
      () =>
        ChildProcess.make("workspace-release-missing-program", [], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      4
    );
    expect(Exit.isFailure(missing)).toBe(true);
    if (Exit.isFailure(missing)) {
      const reason = missing.cause.reasons[0];
      expect(reason?._tag === "Fail" ? reason.error : reason).toMatchObject({
        _tag: "ReleaseServiceApplyFailed",
        generation: 4,
      });
    }
  });
});
