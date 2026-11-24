// Calls the sandbox probe image as the hosted proof's authenticated caller and
// prints one JSON verdict line (sandbox-probe/probe-client.ts). Exits 0 iff the
// verdict is ok. Never prints the ID token or the marker.
//   bun scripts/sandbox-rpc-probe.ts --url <service URL> --id-token-file <file> \
//     --marker-file <file> --traceparent <00-32hex-16hex-01> [--expect-version v1]
import { parseArgs } from "node:util";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { FetchHttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  runSandboxRpcProbe,
  setupFailureVerdict,
} from "../sandbox-probe/probe-client";

class ProbeVerdictFailed extends Schema.TaggedError<ProbeVerdictFailed>()(
  "ProbeVerdictFailed",
  { failures: Schema.Array(Schema.String) }
) {}

const ProbeArguments = Schema.Struct({
  url: Schema.String,
  "id-token-file": Schema.String,
  "marker-file": Schema.String,
  traceparent: Schema.String.check(
    Schema.isPattern(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
  ),
  "expect-version": Schema.optionalKey(Schema.String),
});

/** File contents without the one trailing newline shell redirection adds. */
const readValueFile = (path: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => fileSystem.readFileString(path)),
    Effect.map((text) => text.replace(/\r?\n$/, ""))
  );

const probeTarget = Effect.gen(function* () {
  const { values } = yield* Effect.try(() =>
    parseArgs({
      args: process.argv.slice(2),
      strict: true,
      options: {
        url: { type: "string" },
        "id-token-file": { type: "string" },
        "marker-file": { type: "string" },
        traceparent: { type: "string" },
        "expect-version": { type: "string" },
      },
    })
  );
  const options = yield* Schema.decodeUnknownEffect(ProbeArguments)(values);
  return {
    url: options.url,
    idToken: yield* readValueFile(options["id-token-file"]),
    marker: yield* readValueFile(options["marker-file"]),
    traceparent: options.traceparent,
    expectVersion: options["expect-version"],
  };
});

const probe = probeTarget.pipe(
  Effect.matchEffect({
    onFailure: (error) =>
      Effect.succeed(setupFailureVerdict(`setup: ${error._tag}`)),
    onSuccess: runSandboxRpcProbe,
  }),
  Effect.tap((verdict) => Console.log(JSON.stringify(verdict))),
  Effect.flatMap((verdict) =>
    verdict.ok
      ? Effect.void
      : Effect.fail(new ProbeVerdictFailed({ failures: verdict.failures }))
  )
);

// Failures go to stderr so stdout carries only the verdict line.
BunRuntime.runMain(
  probe.pipe(
    Effect.tapCause((cause) => Console.error(Cause.pretty(cause))),
    Effect.provide(Layer.mergeAll(BunFileSystem.layer, FetchHttpClient.layer))
  ),
  { disableErrorReporting: true }
);
