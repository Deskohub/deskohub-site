import { describe, expect, test } from "bun:test";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Command } from "effect/cli";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { sandboxConfig } from "../config/stack-config.test-utils";
import { ReleaseStack, releaseCommand } from "./release-command";
import {
  ReleaseServiceApply,
  ReleaseServiceReadback,
} from "./release-platform";
import { emptyReleaseRecord, type ReleaseRecord } from "./release-record";
import {
  makeInMemoryReleaseRecordStore,
  ReleaseRecordStore,
} from "./release-record-store";
import { describeStoredRecord, writerFingerprint } from "./release-writer";
import { heldBy } from "./release-writer.test-utils";

/**
 * Runs one command against an in-memory record and a project with no
 * services, whose apply and revision reads must stay untouched.
 */
const runRelease = (
  args: ReadonlyArray<string>,
  initial: ReleaseRecord = emptyReleaseRecord
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* makeInMemoryReleaseRecordStore(initial);
      const platformCalls: Array<string> = [];
      const untouched = (name: string) =>
        Effect.sync(() => {
          platformCalls.push(name);
        }).pipe(Effect.andThen(Effect.die(`unexpected ${name}`)));
      const exit = yield* Command.runWith(releaseCommand, {
        version: "0.0.0",
      })(args).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(ReleaseStack, sandboxConfig),
            Layer.succeed(ReleaseRecordStore, store),
            Layer.succeed(
              ReleaseServiceApply,
              ReleaseServiceApply.of({ apply: () => untouched("apply") })
            ),
            Layer.succeed(
              ReleaseServiceReadback,
              ReleaseServiceReadback.of({
                service: () =>
                  Effect.sync(() => {
                    platformCalls.push("service readback");
                    return null;
                  }),
                revision: () => untouched("revision readback"),
              })
            ),
            BunServices.layer
          )
        ),
        Effect.exit
      );
      return { exit, stored: yield* store.read, platformCalls };
    })
  );

describe("workspace release command", () => {
  test("status reads the record without touching the platform", async () => {
    const result = await runRelease(["status"]);
    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.platformCalls).toEqual([]);
  });

  test("deliver refuses a tag in place of a digest before any write", async () => {
    const result = await runRelease([
      "deliver",
      "--sha",
      "a".repeat(40),
      "--image-digest",
      "latest",
    ]);
    expect(Exit.isFailure(result.exit)).toBe(true);
    expect(result.stored).toEqual({ record: emptyReleaseRecord, version: "1" });
    expect(result.platformCalls).toEqual([]);
  });

  test("restore refuses a malformed release id before any write", async () => {
    const result = await runRelease([
      "restore",
      "--release-id",
      "previous",
      "--expected-generation",
      "0",
    ]);
    expect(Exit.isFailure(result.exit)).toBe(true);
    expect(result.stored.version).toBe("1");
    expect(result.platformCalls).toEqual([]);
  });

  test("recover with nothing pending applies nothing", async () => {
    const result = await runRelease(["recover"]);
    expect(Exit.isSuccess(result.exit)).toBe(true);
    // It only reads the services, to rule out a lost record.
    expect(result.platformCalls).not.toContain("apply");
  });

  test("unlock clears only the lock its fingerprint names", async () => {
    const locked = heldBy(emptyReleaseRecord, "deliver");
    const holder =
      locked.writer === null
        ? ""
        : writerFingerprint(locked.writer.holderDigest);
    const wrong = await runRelease(
      ["unlock", "--holder", "000000000000"],
      locked
    );
    expect(Exit.isFailure(wrong.exit)).toBe(true);
    expect(wrong.stored.record).toEqual(locked);
    const cleared = await runRelease(["unlock", "--holder", holder], locked);
    expect(Exit.isSuccess(cleared.exit)).toBe(true);
    expect(cleared.stored.record.writer).toBeNull();
  });

  test("status names the lock by fingerprint, never by digest", () => {
    const locked = heldBy(emptyReleaseRecord, "deploy");
    const printed = JSON.stringify(
      describeStoredRecord({ record: locked, version: "4" })
    );
    expect(printed).not.toContain(locked.writer?.holderDigest ?? "<none>");
    expect(printed).toContain(
      locked.writer === null
        ? "<none>"
        : writerFingerprint(locked.writer.holderDigest)
    );
  });
});
