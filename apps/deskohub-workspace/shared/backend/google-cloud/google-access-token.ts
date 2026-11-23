import {
  Clock,
  Context,
  Data,
  Duration,
  Effect,
  Layer,
  Option,
  Schema,
  SynchronizedRef,
} from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

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
}

/** Authorizes calls to Google APIs as the runtime's service account. */
export class GoogleAccessToken extends Context.Service<
  GoogleAccessToken,
  IGoogleAccessToken
>()("@deskohub-workspace/GoogleAccessToken") {}

/** Where a Cloud Run service reads its service account's access token. */
export const metadataServerTokenUrl =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-account/token";

const requestTimeout = Duration.seconds(10);
/** Refreshes a token this long before it expires. */
const expiryMargin = Duration.minutes(1);

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.Finite,
});

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

      const fetchToken = Effect.gen(function* () {
        const response = yield* client
          .execute(
            HttpClientRequest.get(metadataServerTokenUrl).pipe(
              HttpClientRequest.setHeader("Metadata-Flavor", "Google")
            )
          )
          .pipe(
            Effect.mapError(
              () => new GoogleAccessTokenError({ reason: "transport" })
            ),
            Effect.timeoutOrElse({
              duration: requestTimeout,
              orElse: () =>
                Effect.fail(new GoogleAccessTokenError({ reason: "timeout" })),
            })
          );
        if (response.status < 200 || response.status >= 300) {
          return yield* new GoogleAccessTokenError({
            reason: "status",
            httpStatus: response.status,
          });
        }
        const token = yield* response.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(TokenResponse)),
          Effect.mapError(
            () => new GoogleAccessTokenError({ reason: "invalid-response" })
          )
        );
        const now = yield* Clock.currentTimeMillis;
        return {
          accessToken: token.access_token,
          refreshAtMillis:
            now + token.expires_in * 1000 - Duration.toMillis(expiryMargin),
        } satisfies CachedToken;
      });

      const reuseOrRefresh = Effect.fn("GoogleAccessToken.get")(function* (
        cached: Option.Option<CachedToken>
      ) {
        const now = yield* Clock.currentTimeMillis;
        const fresh = Option.filter(
          cached,
          ({ refreshAtMillis }) => now < refreshAtMillis
        );
        if (Option.isSome(fresh)) {
          return [fresh.value.accessToken, cached] as const;
        }
        const token = yield* fetchToken;
        return [token.accessToken, Option.some(token)] as const;
      });

      return { get: SynchronizedRef.modifyEffect(cache, reuseOrRefresh) };
    })
  ).pipe(Layer.provide(FetchHttpClient.layer));
