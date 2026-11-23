import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Command } from "effect/cli";
import * as Effect from "effect/Effect";
import packageJson from "./package.json";
import {
  liveReleaseRuntime,
  releaseCommand,
} from "./src/release/release-command";

/**
 * The fenced Workspace release entry: `bun run release <command>`. It reads
 * `WORKSPACE_STACK_CONFIG` like `alchemy.run.ts` and applies services
 * through a generation-fenced `alchemy deploy`.
 */
Command.run(releaseCommand.pipe(Command.provide(liveReleaseRuntime)), {
  version: packageJson.version,
}).pipe(Effect.provide(BunServices.layer), BunRuntime.runMain);
