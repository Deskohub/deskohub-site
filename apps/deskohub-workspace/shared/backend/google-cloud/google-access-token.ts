import {
  Clock,
  Context,
  Data,
  Duration,
  Effect,
  Layer,
  Option,
  Schedule,
  Schema,
  SynchronizedRef,
} from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";

/**
 * No OAuth access token for Google APIs. Carries no token or response body.
 */
export class GoogleAccessTokenError extends Data.TaggedError(
  "GoogleAccessTokenError"
)<{
  readonly reason: "transport" | "timeout" | "status" | "invalid-response";
  readonly httpStatus?: number | undefined;
}> {}

interface IGoogleAccessToken {
  /** An OAuth access token of the runtime's service account. */
  readonly get: Effect.Effect<string, GoogleAccessTokenError>;
  /**
   * Drops `token` after a Google API rejected it, so the next `get` fetches
   * another. A newer token stays.
   */
  readonly invalidate: (token: string) => Effect.Effect<void>;
}

/** Authorizes calls to Google APIs as the runtime's service account. */
export class GoogleAccessToken extends Context.Service<
  GoogleAccessToken,
  IGoogleAccessToken
>()("@deskohub-workspace/GoogleAccessToken") {}

/** Where a Cloud Run service reads its service account's access token. */
export const metadataServerTokenUrl =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

/** Bounds each attempt, response body included. */
const attemptTimeout = Duration.seconds(10);
const retrySchedule = Schedule.exponential("200 millis");
const retries = 2;
/** Refreshes a token this long before it expires. */
const expiryMargin = Duration.minutes(1);

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.Finite,
});
type TokenResponse = typeof TokenResponse.Type;

type CachedToken = {
  readonly accessToken: string;
  readonly refreshAtMillis: number;
};

/**
 * Reads the token from the Cloud Run metadata server and reuses it until
 * shortly before it expires. Concurrent callers share one refresh.
 */
export const MetadataServerGoogleAccessToken: Layer.Layer<GoogleAccessToken> =
  Layer.effect(
    GoogleAccessToken,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const cache = yield* SynchronizedRef.make(Option.none<CachedToken>());

      const requestToken = client
        .execute(
          HttpClientRequest.get(metadataServerTokenUrl).pipe(
            HttpClientRequest.setHeader("Metadata-Flavor", "Google")
          )
        )
        .pipe(
          Effect.mapError(
            () => new GoogleAccessTokenError({ reason: "transport" })
          ),
          Effect.filterOrElse(isSuccessful, (response) =>
            Effect.fail(
              new GoogleAccessTokenError({
                reason: "status",
                httpStatus: response.status,
              })
            )
          ),
          Effect.flatMap(readTokenResponse),
          Effect.timeoutOrElse({
            duration: attemptTimeout,
            orElse: () =>
              Effect.fail(new GoogleAccessTokenError({ reason: "timeout" })),
          }),
          Effect.retry({
            schedule: retrySchedule,
            times: retries,
            while: isTransient,
          })
        );

      const fetchToken = Effect.Do.pipe(
        Effect.bind("response", () => requestToken),
        Effect.bind("now", () => Clock.currentTimeMillis),
        Effect.map(toCachedToken)
      );

      const reuseOrRefresh = (cached: Option.Option<CachedToken>) =>
        Clock.currentTimeMillis.pipe(
          Effect.map((now) =>
            Option.filter(
              cached,
              ({ refreshAtMillis }) => now < refreshAtMillis
            )
          ),
          Effect.flatMap(
            Option.match({
              onSome: ({ accessToken }) =>
                Effect.succeed([accessToken, cached] as const),
              onNone: () =>
                fetchToken.pipe(
                  Effect.map(
                    (token) => [token.accessToken, Option.some(token)] as const
                  )
                ),
            })
          )
        );

      return {
        get: SynchronizedRef.modifyEffect(cache, reuseOrRefresh).pipe(
          Effect.withSpan("GoogleAccessToken.get")
        ),
        invalidate: (token) =>
          SynchronizedRef.update(
            cache,
            Option.filter(({ accessToken }) => accessToken !== token)
          ),
      };
    })
  ).pipe(Layer.provide(FetchHttpClient.layer));

const isSuccessful = ({ status }: HttpClientResponse.HttpClientResponse) =>
  status >= 200 && status < 300;

const readTokenResponse = (response: HttpClientResponse.HttpClientResponse) =>
  response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(TokenResponse)),
    Effect.mapError(
      () => new GoogleAccessTokenError({ reason: "invalid-response" })
    )
  );

const isTransient = ({ reason, httpStatus }: GoogleAccessTokenError) =>
  reason === "transport" ||
  reason === "timeout" ||
  httpStatus === 429 ||
  (httpStatus !== undefined && httpStatus >= 500);

const toCachedToken = ({
  response,
  now,
}: {
  readonly response: TokenResponse;
  readonly now: number;
}): CachedToken => ({
  accessToken: response.access_token,
  refreshAtMillis:
    now + response.expires_in * 1000 - Duration.toMillis(expiryMargin),
});
