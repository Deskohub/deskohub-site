// The hosted proof's caller for the probe image: checks /healthz, then calls
// each SandboxProbeRpcs RPC over POST /rpc with SchemaBinary and reports one
// verdict. Failures name the step and error tag only, never the token or marker.
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { markerSha256, SandboxProbeRpcs } from "./probe-rpcs";

export const schemaBinaryContentType =
  "application/vnd.effect.rpc+schema-binary";

export interface ProbeTarget {
  /** The service origin, without the /rpc path. */
  readonly url: string;
  readonly idToken: string;
  readonly marker: string;
  readonly traceparent: string;
  readonly expectVersion?: string | undefined;
}

export interface ProbeVerdict {
  readonly ok: boolean;
  readonly version: string | null;
  /** Status of the first /rpc response, 0 when none arrived. */
  readonly status: number;
  /** Content type of the first /rpc response, empty when none arrived. */
  readonly contentType: string;
  readonly markerSha256: string;
  readonly markerMatches: boolean;
  readonly failDecoded: "ProbeRejected" | null;
  readonly countChunks: ReadonlyArray<number>;
  readonly failures: ReadonlyArray<string>;
}

interface RpcResponseMeta {
  readonly status: number;
  readonly contentType: string;
}

const HealthBody = Schema.Struct({
  status: Schema.Literal("ok"),
  version: Schema.String,
});

const expectedCount = 3;

const probeHealth = (http: HttpClient.HttpClient, origin: string) =>
  http.get(`${origin}/healthz`).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(HealthBody)),
            Effect.map(({ version }) => version),
            Effect.mapError((error) => `healthz: ${error._tag}`)
          )
        : Effect.fail(`healthz: status ${response.status}`)
    ),
    Effect.catchTag("HttpClientError", (error) =>
      Effect.fail(`healthz: ${error._tag} ${error.reason._tag}`)
    )
  );

/** Runs every probe check and never fails: problems land in `failures`. */
export const runSandboxRpcProbe = Effect.fnUntraced(
  function* (target: ProbeTarget) {
    const origin = target.url.replace(/\/+$/, "");
    const responses = yield* Ref.make<ReadonlyArray<RpcResponseMeta>>([]);
    const http = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest((request) =>
        request.pipe(
          HttpClientRequest.bearerToken(target.idToken),
          HttpClientRequest.setHeader("traceparent", target.traceparent)
        )
      )
    );
    const rpcHttp = http.pipe(
      HttpClient.tap((response) =>
        Ref.update(responses, (seen) => [
          ...seen,
          {
            status: response.status,
            contentType: response.headers["content-type"] ?? "",
          },
        ])
      )
    );
    const rpc = yield* RpcClient.make(SandboxProbeRpcs, {
      disableTracing: true,
    }).pipe(
      Effect.provide(
        RpcClient.layerProtocolHttp({ url: `${origin}/rpc` }).pipe(
          Layer.provide(
            Layer.mergeAll(
              RpcSerialization.layerSchemaBinary(),
              Layer.succeed(HttpClient.HttpClient)(rpcHttp)
            )
          )
        )
      )
    );

    const health = yield* Effect.result(probeHealth(http, origin));
    const ingest = yield* Effect.result(
      rpc["Probe.ingest"]({ marker: target.marker })
    );
    const rejected: Result.Result<"ProbeRejected", string> = yield* rpc[
      "Probe.fail"
    ]().pipe(
      Effect.as(Result.fail("Probe.fail: succeeded")),
      Effect.catchTags({
        ProbeRejected: () =>
          Effect.succeed(Result.succeed("ProbeRejected" as const)),
        RpcClientError: (error) =>
          Effect.succeed(Result.fail(`Probe.fail: ${error._tag}`)),
      })
    );
    const count = yield* Effect.result(
      Stream.runCollect(rpc["Probe.count"]({ n: expectedCount })).pipe(
        Effect.mapError((error) => `Probe.count: ${error._tag}`)
      )
    );
    const seen = yield* Ref.get(responses);
    const expectedDigest = markerSha256(target.marker);
    const version = Result.getOrNull(health);
    const digest = ingest.pipe(
      Result.map((body) => body.markerSha256),
      Result.getOrElse(() => "")
    );
    const countChunks = Result.getOrElse(count, () => []);
    const first = seen[0];
    const failures = [
      ...Result.match(health, {
        onSuccess: (reported) =>
          target.expectVersion === undefined ||
          reported === target.expectVersion
            ? []
            : [
                `healthz: version ${reported}, expected ${target.expectVersion}`,
              ],
        onFailure: (failure) => [failure],
      }),
      ...seen.flatMap(({ status, contentType }, index) => [
        ...(status === 200 ? [] : [`rpc response ${index}: status ${status}`]),
        ...(contentType === schemaBinaryContentType
          ? []
          : [`rpc response ${index}: content type ${contentType}`]),
      ]),
      ...(seen.length === 0 ? ["rpc: no response"] : []),
      ...Result.match(ingest, {
        onSuccess: () =>
          digest === expectedDigest ? [] : ["Probe.ingest: digest mismatch"],
        onFailure: (error) => [`Probe.ingest: ${error._tag}`],
      }),
      ...Result.match(rejected, {
        onSuccess: () => [],
        onFailure: (failure) => [failure],
      }),
      ...Result.match(count, {
        onSuccess: (chunks) =>
          chunks.length === expectedCount &&
          chunks.every((value, index) => value === index)
            ? []
            : [`Probe.count: chunks ${chunks.join(",")}`],
        onFailure: (failure) => [failure],
      }),
    ];
    return {
      ok: failures.length === 0,
      version,
      status: first?.status ?? 0,
      contentType: first?.contentType ?? "",
      markerSha256: digest,
      markerMatches: digest === expectedDigest,
      failDecoded: Result.getOrNull(rejected),
      countChunks,
      failures,
    } satisfies ProbeVerdict;
  },
  Effect.scoped,
  Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
);
