import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";
import {
  type ProbeTarget,
  runSandboxRpcProbe,
  schemaBinaryContentType,
} from "./probe-client";
import { probeVersion, runWithProbe } from "./probe-server.test-utils";

const marker = "synthetic-probe-marker-41aa";
const digest = new Bun.CryptoHasher("sha256").update(marker).digest("hex");
const idToken = "synthetic-id-token-9f2e";
const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const packageDir = join(import.meta.dir, "..");

const targetAt = (origin: string): ProbeTarget => ({
  url: origin,
  idToken,
  marker,
  traceparent,
  expectVersion: probeVersion,
});

const scratchDirs: string[] = [];

afterEach(async () => {
  for (const dir of scratchDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("sandbox RPC probe verdict", () => {
  test("passes against the api role", async () => {
    const verdict = await runWithProbe("api", ({ origin }) =>
      runSandboxRpcProbe(targetAt(`${origin}/`))
    );
    expect(verdict).toEqual({
      ok: true,
      version: probeVersion,
      status: 200,
      contentType: schemaBinaryContentType,
      markerSha256: digest,
      markerMatches: true,
      failDecoded: "ProbeRejected",
      countChunks: [0, 1, 2],
      failures: [],
    });
  });

  test("fails on an unexpected build version", async () => {
    const verdict = await runWithProbe("api", ({ origin }) =>
      runSandboxRpcProbe({ ...targetAt(origin), expectVersion: "v9" })
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.version).toBe(probeVersion);
    expect(verdict.failures).toHaveLength(1);
  });

  test("fails when the service mounts no /rpc", async () => {
    const verdict = await runWithProbe("tasks-worker", ({ origin }) =>
      runSandboxRpcProbe(targetAt(origin))
    );
    expect(verdict).toMatchObject({
      ok: false,
      version: probeVersion,
      status: 404,
      markerSha256: "",
      markerMatches: false,
      failDecoded: null,
      countChunks: [],
    });
    expect(verdict.failures.length).toBeGreaterThan(0);
  });

  test("sends the bearer token and traceparent on every request", async () => {
    const seen: Array<{ path: string; authorization: string; trace: string }> =
      [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        seen.push({
          path: new URL(request.url).pathname,
          authorization: request.headers.get("authorization") ?? "",
          trace: request.headers.get("traceparent") ?? "",
        });
        return new Response("denied", { status: 403 });
      },
    });
    try {
      const verdict = await Effect.runPromise(
        runSandboxRpcProbe(targetAt(server.url.origin)).pipe(
          Effect.provide(FetchHttpClient.layer)
        )
      );
      expect(verdict).toMatchObject({ ok: false, version: null, status: 403 });
      expect(seen.length).toBeGreaterThan(1);
      expect(
        seen.every(
          ({ authorization, trace }) =>
            authorization === `Bearer ${idToken}` && trace === traceparent
        )
      ).toBe(true);
      expect(JSON.stringify(verdict)).not.toContain(idToken);
      expect(JSON.stringify(verdict)).not.toContain(marker);
    } finally {
      await server.stop(true);
    }
  });
});

describe("sandbox-rpc-probe CLI", () => {
  const runCli = (origin: string, expectVersion: string) =>
    Effect.promise(async () => {
      const dir = await mkdtemp(join(tmpdir(), "sandbox-rpc-probe-"));
      scratchDirs.push(dir);
      await Bun.write(join(dir, "token"), `${idToken}\n`);
      await Bun.write(join(dir, "marker"), `${marker}\n`);
      const child = Bun.spawn(
        [
          process.execPath,
          "scripts/sandbox-rpc-probe.ts",
          "--url",
          origin,
          "--id-token-file",
          join(dir, "token"),
          "--marker-file",
          join(dir, "marker"),
          "--traceparent",
          traceparent,
          "--expect-version",
          expectVersion,
        ],
        { cwd: packageDir, stdout: "pipe", stderr: "pipe" }
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout, stderr, exitCode };
    });

  test("prints one ok verdict line and exits 0", async () => {
    const { stdout, stderr, exitCode } = await runWithProbe(
      "api",
      ({ origin }) => runCli(origin, probeVersion)
    );
    expect(exitCode).toBe(0);
    const lines = stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      ok: true,
      markerSha256: digest,
      markerMatches: true,
    });
    expect(stdout + stderr).not.toContain(idToken);
    expect(stdout + stderr).not.toContain(marker);
  });

  test("exits non-zero on a failing verdict", async () => {
    const { stdout, stderr, exitCode } = await runWithProbe(
      "api",
      ({ origin }) => runCli(origin, "v9")
    );
    expect(exitCode).not.toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false });
    expect(stdout + stderr).not.toContain(idToken);
  });
});
