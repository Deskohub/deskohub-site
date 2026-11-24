// The hosted proof's caller for the probe image: checks /healthz, then calls
// each SandboxProbeRpcs RPC over POST /rpc with SchemaBinary and reports one
// verdict. Failures name the step and error tag only, and every remote string
// in the verdict is redacted, so it never carries the token or the marker.
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { sha256Hex } from "../src/sha256";
import { SandboxProbeRpcs } from "./probe-rpcs";

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
  /** The digest Probe.ingest returned, empty unless it matches the marker's. */
  readonly markerSha256: string;
  readonly markerMatches: boolean;
  readonly failDecoded: "ProbeRejected" | null;
  /** The values Probe.count streamed, one per RPC chunk. */
  readonly countChunks: ReadonlyArray<number>;
  readonly failures: ReadonlyArray<string>;
}

/** The verdict when the probe could not start, such as an unreadable input file. */
export const setupFailureVerdict = (failure: string): ProbeVerdict => ({
  ok: false,
  version: null,
  status: 0,
  contentType: "",
  markerSha256: "",
  markerMatches: false,
  failDecoded: null,
  countChunks: [],
  failures: [failure],
});

const printable = (contentType: string) =>
  contentType === "" || printableContentType.test(contentType)
    ? contentType
    : "[unprintable]";

interface RpcResponseMeta {
  readonly status: number;
  readonly contentType: string;
}

const HealthBody = Schema.Struct({
  status: Schema.Literal("ok"),
  version: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]{1,64}$/)),
});

/** A content type the verdict may print; anything else shows as a placeholder. */
const printableContentType = /^[\w.+/-]{1,64}(?:;\s*[\w.+/=-]{1,64})*$/;

/** Generous: the hosted proof's cold starts can take tens of seconds. */
const stepTimeout = Duration.seconds(60);

/**
 * Bounds a step and turns its defects and timeout into safe failures, so the
 * probe always reaches a verdict. Interruption still propagates.
 */
const settleStep =
  (name: string) =>
  <A>(
    step: Effect.Effect<Result.Result<A, string>>
  ): Effect.Effect<Result.Result<A, string>> =>
    step.pipe(
      Effect.catchDefect(() => Effect.succeed(Result.fail(`${name}: defect`))),
      Effect.timeoutOrElse({
        duration: stepTimeout,
        orElse: () => Effect.succeed(Result.fail(`${name}: timeout`)),
      })
    );

const expectedCount = 3;

const authorizedClient = (target: ProbeTarget) =>
  HttpClient.HttpClient.pipe(
    Effect.map(
      HttpClient.mapRequest((request) =>
        request.pipe(
          HttpClientRequest.bearerToken(target.idToken),
          HttpClientRequest.setHeader("traceparent", target.traceparent)
        )
      )
    )
  );

/** What the client saw on the wire: each /rpc response and the stream chunk frame count. */
interface RpcObservations {
  readonly responses: Ref.Ref<ReadonlyArray<RpcResponseMeta>>;
  readonly chunkFrames: Ref.Ref<number>;
}

const observeResponses =
  (observations: RpcObservations) => (http: HttpClient.HttpClient) =>
    http.pipe(
      HttpClient.tap((response) =>
        Ref.update(observations.responses, (seen) => [
          ...seen,
          {
            status: response.status,
            contentType: printable(response.headers["content-type"] ?? ""),
          },
        ])
      )
    );

/**
 * The HTTP protocol, counting every decoded `Chunk` message: stream values
 * the client batches into one pull still arrive here frame by frame.
 */
const observedProtocol = (
  http: HttpClient.HttpClient,
  rpcUrl: string,
  observations: RpcObservations
) =>
  Layer.effect(RpcClient.Protocol)(
    RpcClient.makeProtocolHttp(
      observeResponses(observations)(
        HttpClient.mapRequest(http, HttpClientRequest.prependUrl(rpcUrl))
      )
    ).pipe(
      Effect.map((protocol) => ({
        ...protocol,
        run: (
          clientId: number,
          onMessage: Parameters<typeof protocol.run>[1]
        ) =>
          protocol.run(clientId, (message) =>
            Effect.andThen(
              Predicate.isTagged(message, "Chunk")
                ? Ref.update(observations.chunkFrames, (frames) => frames + 1)
                : Effect.void,
              onMessage(message)
            )
          ),
      }))
    )
  );

/** A SchemaBinary RPC client over `observedProtocol`. */
const probeRpcClient = (
  http: HttpClient.HttpClient,
  rpcUrl: string,
  observations: RpcObservations
) =>
  RpcClient.make(SandboxProbeRpcs, { disableTracing: true }).pipe(
    Effect.provide(
      observedProtocol(http, rpcUrl, observations).pipe(
        Layer.provide(RpcSerialization.layerSchemaBinary())
      )
    )
  );

type ProbeRpcClient = Effect.Success<ReturnType<typeof probeRpcClient>>;

const checkHealth = (http: HttpClient.HttpClient, origin: string) =>
  // Cloud Run reserves some paths ending in "z" on its public URL, so the
  // caller uses /health; the startup probe keeps /healthz.
  http.get(`${origin}/health`).pipe(
    Effect.mapError((error) => `healthz: ${error._tag}`),
    Effect.flatMap((response) =>
      response.status === 200
        ? HttpClientResponse.schemaBodyJson(HealthBody)(response).pipe(
            Effect.map(({ version }) => version),
            Effect.mapError((error) => `healthz: ${error._tag}`)
          )
        : Effect.fail(`healthz: status ${response.status}`)
    ),
    Effect.result,
    settleStep("healthz")
  );

const ingestMarker = (rpc: ProbeRpcClient, marker: string) =>
  rpc["Probe.ingest"]({ marker }).pipe(
    Effect.map(({ markerSha256 }) => markerSha256),
    Effect.mapError((error) => `Probe.ingest: ${error._tag}`),
    Effect.result,
    settleStep("Probe.ingest")
  );

const decodeRejection = (
  rpc: ProbeRpcClient
): Effect.Effect<Result.Result<"ProbeRejected", string>> =>
  rpc["Probe.fail"]({}).pipe(
    Effect.as(Result.fail("Probe.fail: succeeded")),
    Effect.catchTags({
      ProbeRejected: () =>
        Effect.succeed(Result.succeed("ProbeRejected" as const)),
      RpcClientError: (error) =>
        Effect.succeed(Result.fail(`Probe.fail: ${error._tag}`)),
    }),
    settleStep("Probe.fail")
  );

const collectCount = (rpc: ProbeRpcClient) =>
  Stream.runCollect(rpc["Probe.count"]({ n: expectedCount })).pipe(
    Effect.mapError((error) => `Probe.count: ${error._tag}`),
    Effect.result,
    settleStep("Probe.count")
  );

interface ProbeSteps {
  readonly health: Result.Result<string, string>;
  readonly ingest: Result.Result<string, string>;
  readonly rejected: Result.Result<"ProbeRejected", string>;
  readonly count: Result.Result<ReadonlyArray<number>, string>;
  readonly responses: ReadonlyArray<RpcResponseMeta>;
  readonly chunkFrames: number;
}

const redactorFor = (target: ProbeTarget) => {
  const secrets = [target.idToken, target.marker].filter(
    (secret) => secret.length > 0
  );
  return (text: string) =>
    secrets.reduce(
      (redacted, secret) => redacted.replaceAll(secret, "[redacted]"),
      text
    );
};

const healthFailures = (target: ProbeTarget, health: ProbeSteps["health"]) =>
  Result.match(health, {
    onSuccess: (reported) =>
      target.expectVersion === undefined || reported === target.expectVersion
        ? []
        : [`healthz: version ${reported}, expected ${target.expectVersion}`],
    onFailure: (failure) => [failure],
  });

const responseFailures = (responses: ProbeSteps["responses"]) =>
  responses.length === 0
    ? ["rpc: no response"]
    : responses.flatMap(({ status, contentType }, index) => [
        ...(status === 200 ? [] : [`rpc response ${index}: status ${status}`]),
        ...(contentType === schemaBinaryContentType
          ? []
          : [`rpc response ${index}: content type ${contentType}`]),
      ]);

/** Probe.count must stream 0, 1, 2 in three chunk frames, so one value each. */
const countFailures = (
  count: ProbeSteps["count"],
  chunkFrames: ProbeSteps["chunkFrames"]
) => [
  ...Result.match(count, {
    onSuccess: (values) =>
      values.length === expectedCount &&
      values.every((value, index) => value === index)
        ? []
        : [`Probe.count: values ${values.join(",")}`],
    onFailure: (failure) => [failure],
  }),
  ...(chunkFrames === expectedCount
    ? []
    : [`Probe.count: ${chunkFrames} chunk frames`]),
];

const probeVerdict = (target: ProbeTarget, steps: ProbeSteps): ProbeVerdict => {
  const redact = redactorFor(target);
  const expectedDigest = sha256Hex(target.marker);
  const markerMatches = Result.getOrNull(steps.ingest) === expectedDigest;
  const failures = [
    ...healthFailures(target, steps.health),
    ...responseFailures(steps.responses),
    ...Result.match(steps.ingest, {
      onSuccess: () => (markerMatches ? [] : ["Probe.ingest: digest mismatch"]),
      onFailure: (failure) => [failure],
    }),
    ...Result.match(steps.rejected, {
      onSuccess: () => [],
      onFailure: (failure) => [failure],
    }),
    ...countFailures(steps.count, steps.chunkFrames),
  ].map(redact);
  const first = steps.responses[0];
  const version = Result.getOrNull(steps.health);
  return {
    ok: failures.length === 0,
    version: version === null ? null : redact(version),
    status: first?.status ?? 0,
    contentType: redact(first?.contentType ?? ""),
    markerSha256: markerMatches ? expectedDigest : "",
    markerMatches,
    failDecoded: Result.getOrNull(steps.rejected),
    countChunks: Result.getOrElse(steps.count, () => []),
    failures,
  };
};

/** Runs every probe check and never fails: problems land in `failures`. */
export const runSandboxRpcProbe = (target: ProbeTarget) => {
  const origin = target.url.replace(/\/+$/, "");
  return Effect.Do.pipe(
    Effect.bind("observations", () =>
      Effect.all({
        responses: Ref.make<ReadonlyArray<RpcResponseMeta>>([]),
        chunkFrames: Ref.make(0),
      })
    ),
    Effect.bind("http", () => authorizedClient(target)),
    Effect.bind("rpc", ({ http, observations }) =>
      probeRpcClient(http, `${origin}/rpc`, observations)
    ),
    Effect.bind("health", ({ http }) => checkHealth(http, origin)),
    Effect.bind("ingest", ({ rpc }) => ingestMarker(rpc, target.marker)),
    Effect.bind("rejected", ({ rpc }) => decodeRejection(rpc)),
    Effect.bind("count", ({ rpc }) => collectCount(rpc)),
    Effect.bind("responses", ({ observations }) =>
      Ref.get(observations.responses)
    ),
    Effect.bind("chunkFrames", ({ observations }) =>
      Ref.get(observations.chunkFrames)
    ),
    Effect.map((steps) => probeVerdict(target, steps)),
    Effect.scoped,
    Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
  );
};
