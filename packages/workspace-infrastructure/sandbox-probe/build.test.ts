import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceRole } from "./probe";

let outdir = "";

beforeAll(async () => {
  outdir = await mkdtemp(join(tmpdir(), "sandbox-probe-build-"));
  const build = Bun.spawn(
    [process.execPath, join(import.meta.dir, "build.ts"), "--outdir", outdir],
    { stdout: "ignore", stderr: "inherit" }
  );
  expect(await build.exited).toBe(0);
});

afterAll(async () => {
  await rm(outdir, { recursive: true, force: true });
});

/** Reads the bundle's first stdout line: the listening address. */
const listeningAddress = async (stdout: ReadableStream<Uint8Array>) => {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stdout) {
    text += decoder.decode(chunk);
    if (text.includes("\n")) {
      break;
    }
  }
  const line: { event: string; address: string } = JSON.parse(
    text.split("\n")[0] ?? ""
  );
  expect(line.event).toBe("probe.listening");
  return line.address;
};

describe("sandbox probe bundle", () => {
  test("writes only probe.mjs", async () => {
    expect(await readdir(outdir)).toEqual(["probe.mjs"]);
  });

  test.each<ServiceRole>(["api", "tasks-worker", "scheduler-worker"])(
    "serves /healthz under Node as %s",
    async (role) => {
      const probe = Bun.spawn(["node", join(outdir, "probe.mjs")], {
        env: {
          PATH: process.env.PATH,
          PORT: "0",
          PROBE_BUILD_VERSION: "v3",
          WORKSPACE_SERVICE_ROLE: role,
        },
        stdout: "pipe",
        stderr: "inherit",
      });
      try {
        const address = await listeningAddress(probe.stdout);
        const response = await fetch(`${address}/healthz`);
        expect(await response.json()).toEqual({
          status: "ok",
          version: "v3",
          role,
        });
      } finally {
        probe.kill();
        await probe.exited;
      }
    }
  );

  test("refuses to start without a valid service role", async () => {
    const probe = Bun.spawn(["node", join(outdir, "probe.mjs")], {
      env: { PATH: process.env.PATH, PORT: "0", WORKSPACE_SERVICE_ROLE: "web" },
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await probe.exited).not.toBe(0);
  });
});
