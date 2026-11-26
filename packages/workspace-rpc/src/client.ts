import { Context, Effect, Layer, Option, Redacted } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import { RpcClient, RpcClientError, RpcSerialization } from "effect/rpc";
import { InvalidCallerHeaders } from "./caller";
import {
  type CampaignUnsubscribeRejected,
  type CampaignUnsubscribeToken,
  openPreferences,
  unsubscribeOneClick,
} from "./email-preferences";
import { BackendUnavailable } from "./errors";
import { WorkspaceRpcSerialization } from "./serialization";
import { WorkspaceRpcs } from "./workspace-rpcs";

interface WorkspaceRpcProtocolOptions {
  readonly url: string;
  readonly authorization: Effect.Effect<
    Redacted.Redacted<string>,
    BackendUnavailable
  >;
  readonly invalidateAuthorization: (
    rejectedToken: Redacted.Redacted<string>
  ) => Effect.Effect<void>;
}

const RetryUnauthorized = Context.Reference<boolean>(
  "@deskohub/workspace-rpc/RetryUnauthorized",
  { defaultValue: () => false }
);

const contentTypeOf = (response: HttpClientResponse.HttpClientResponse) => {
  const contentType = response.headers["content-type"];
  return contentType?.includes(",")
    ? undefined
    : contentType?.split(";", 1)[0]?.trim().toLowerCase();
};

const isIamRejection = (
  response: HttpClientResponse.HttpClientResponse,
  hasRpcContentType: boolean
) =>
  (response.status === 401 || response.status === 403) &&
  !hasRpcContentType &&
  response.headers.server?.toLowerCase() === "google frontend";

const discardBody = (response: HttpClientResponse.HttpClientResponse) =>
  HttpClientResponse.toWeb(response).pipe(
    Option.match({
      onNone: () => Effect.void,
      onSome: (webResponse) =>
        Effect.tryPromise(
          () => webResponse.body?.cancel() ?? Promise.resolve()
        ).pipe(Effect.ignore),
    })
  );

export const layerWorkspaceRpcProtocol = (
  options: WorkspaceRpcProtocolOptions
) =>
  Layer.effect(RpcClient.Protocol)(
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      const { contentType } = yield* RpcSerialization.RpcSerialization;

      const send = Effect.fnUntraced(function* (
        request: HttpClientRequest.HttpClientRequest,
        canRetry: boolean
      ): Effect.fn.Return<
        HttpClientResponse.HttpClientResponse,
        HttpClientError.HttpClientError
      > {
        const token = yield* options.authorization.pipe(
          Effect.mapError(
            (cause) =>
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request, cause }),
              })
          )
        );
        const fetchOptions = yield* Effect.serviceOption(
          FetchHttpClient.RequestInit
        );
        const response = yield* http
          .execute(
            HttpClientRequest.bearerToken(request, Redacted.value(token))
          )
          .pipe(
            Effect.provideService(FetchHttpClient.RequestInit, {
              ...Option.getOrUndefined(fetchOptions),
              redirect: "manual",
            })
          );
        const hasRpcContentType = contentTypeOf(response) === contentType;
        const iamRejection = isIamRejection(response, hasRpcContentType);
        const unauthorized = response.status === 401;
        const retryUnauthorized = yield* RetryUnauthorized;
        const shouldRetry =
          canRetry && (iamRejection || (unauthorized && retryUnauthorized));

        if (unauthorized || (iamRejection && shouldRetry)) {
          yield* options.invalidateAuthorization(token);
        }
        if (
          response.status >= 200 &&
          response.status < 300 &&
          hasRpcContentType
        ) {
          return response;
        }

        yield* discardBody(response);
        if (shouldRetry) {
          return yield* send(request, false);
        }

        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.StatusCodeError({
            request,
            response,
            cause: new BackendUnavailable({
              reason:
                response.status >= 200 && response.status < 300
                  ? "content-type"
                  : "http-status",
              status: response.status,
            }),
          }),
        });
      });

      const client = HttpClient.makeWith<
        never,
        never,
        HttpClientError.HttpClientError,
        never
      >(
        (request) =>
          Effect.flatMap(request, (prepared) => send(prepared, true)),
        Effect.succeed
      ).pipe(
        HttpClient.mapRequest(
          HttpClientRequest.setUrl(`${options.url.replace(/\/+$/, "")}/rpc`)
        )
      );
      const protocol = yield* RpcClient.makeProtocolHttp(client);
      return {
        ...protocol,
        send: (clientId, request, transferables) =>
          protocol
            .send(clientId, request, transferables)
            .pipe(
              Effect.provideService(
                RetryUnauthorized,
                request._tag === "Request" &&
                  request.tag === unsubscribeOneClick
              )
            ),
      };
    })
  ).pipe(Layer.provide(WorkspaceRpcSerialization));

const mapClientError = (
  error: RpcClientError.RpcClientError | InvalidCallerHeaders
): BackendUnavailable => {
  if (error instanceof InvalidCallerHeaders) {
    return new BackendUnavailable({ reason: "caller" });
  }
  if (error.reason._tag === "HttpError") {
    const cause = error.reason.cause;
    if (
      (cause instanceof HttpClientError.StatusCodeError ||
        cause instanceof HttpClientError.TransportError) &&
      cause.cause instanceof BackendUnavailable
    ) {
      return cause.cause;
    }
    return new BackendUnavailable({ reason: "transport" });
  }
  return new BackendUnavailable({ reason: "protocol" });
};

const withBackendFailures = <A, R>(
  effect: Effect.Effect<
    A,
    | BackendUnavailable
    | CampaignUnsubscribeRejected
    | InvalidCallerHeaders
    | RpcClientError.RpcClientError,
    R
  >
): Effect.Effect<A, BackendUnavailable | CampaignUnsubscribeRejected, R> =>
  effect.pipe(
    Effect.catchIf(
      (error) =>
        error instanceof RpcClientError.RpcClientError ||
        error instanceof InvalidCallerHeaders,
      (error) => Effect.fail(mapClientError(error))
    ),
    Effect.catchDefect(() =>
      Effect.fail(new BackendUnavailable({ reason: "protocol" }))
    )
  );

export const makeWorkspaceRpcClient = () =>
  RpcClient.make(WorkspaceRpcs, { flatten: true }).pipe(
    Effect.map((client) => ({
      openPreferences: (payload: {
        readonly token: CampaignUnsubscribeToken;
      }) => withBackendFailures(client(openPreferences, payload)),
      unsubscribeOneClick: (payload: {
        readonly token: CampaignUnsubscribeToken;
      }) => withBackendFailures(client(unsubscribeOneClick, payload)),
    }))
  );
