import { Context, Data, Effect } from "effect";
import {
  createRemoteJWKSet,
  type JWTVerifyGetKey,
  errors as joseErrors,
  jwtVerify,
} from "jose";
import { env } from "@/env";

/**
 * A Google service account allowed to call a private worker: the account a
 * Cloud Tasks queue or Cloud Scheduler job signs its OIDC token as, and the
 * audience it signs the token for.
 */
export interface GoogleInvoker {
  readonly email: string;
  readonly audience: string;
}

const googleInvoker = (
  email: string | undefined,
  audience: string | undefined
): GoogleInvoker | undefined =>
  email && audience ? { email, audience } : undefined;

/** The invoker Cloud Tasks queues deliver as; unset until both settings are. */
export const cloudTasksInvoker = () =>
  googleInvoker(
    env.WORKSPACE_TASKS_INVOKER_EMAIL,
    env.WORKSPACE_TASKS_AUDIENCE
  );

/** The invoker Cloud Scheduler jobs call as; unset until both settings are. */
export const cloudSchedulerInvoker = () =>
  googleInvoker(
    env.WORKSPACE_SCHEDULER_INVOKER_EMAIL,
    env.WORKSPACE_SCHEDULER_AUDIENCE
  );

const googleCertificatesUrl = new URL(
  "https://www.googleapis.com/oauth2/v3/certs"
);
let googleSigningKeys: JWTVerifyGetKey | undefined;

/**
 * The keys Google signs OIDC tokens with. The default fetches and caches
 * Google's published key set, refetching for an unknown key ID; tests provide
 * a local key set.
 */
export const GoogleIdentityKeys = Context.Reference<JWTVerifyGetKey>(
  "@deskohub-workspace/GoogleIdentityKeys",
  {
    defaultValue: () => {
      googleSigningKeys ??= createRemoteJWKSet(googleCertificatesUrl);
      return googleSigningKeys;
    },
  }
);

const googleIssuers = ["https://accounts.google.com", "accounts.google.com"];

/** Google OIDC tokens live one hour; allow for clock drift either side. */
const maxTokenAgeSeconds = 60 * 60;
const clockToleranceSeconds = 30;

/**
 * Why a request is not from the expected invoker. It never carries the token
 * or its claims, so it is safe to log.
 */
export class GoogleInvokerRejection extends Data.TaggedError(
  "GoogleInvokerRejection"
)<{
  /** 401 without a valid Google token; 403 for a valid one from another account. */
  readonly status: 401 | 403;
  readonly reason:
    | "invoker-not-configured"
    | "missing-bearer-token"
    | "invalid-token"
    | "unexpected-invoker";
  /** The jose error code of an invalid token, such as `ERR_JWT_EXPIRED`. */
  readonly code?: string;
}> {}

const bearerToken = (request: Request) =>
  request.headers
    .get("authorization")
    ?.match(/^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/)?.[1];

const verifyToken = Effect.fnUntraced(function* (
  token: string,
  invoker: GoogleInvoker
) {
  const keys = yield* GoogleIdentityKeys;
  return yield* Effect.tryPromise({
    try: () =>
      jwtVerify(token, keys, {
        algorithms: ["RS256"],
        issuer: googleIssuers,
        audience: invoker.audience,
        maxTokenAge: maxTokenAgeSeconds,
        clockTolerance: clockToleranceSeconds,
        requiredClaims: ["exp", "iat", "email"],
      }),
    catch: (error) =>
      new GoogleInvokerRejection({
        status: 401,
        reason: "invalid-token",
        code:
          error instanceof joseErrors.JOSEError
            ? error.code
            : "ERR_KEY_SET_UNAVAILABLE",
      }),
  });
});

/**
 * Authenticates a request as `invoker`: a Google-signed RS256 OIDC bearer
 * token for exactly its audience, from Google's issuer, unexpired, whose
 * verified `email` is the invoker's account. Without an invoker, every request
 * is rejected, so a host missing its settings fails closed. Transport headers
 * such as `X-CloudTasks-*` never authenticate a request.
 */
export const authenticateGoogleInvoker = Effect.fn(
  "googleOidc.authenticateInvoker"
)(function* (request: Request, invoker: GoogleInvoker | undefined) {
  if (invoker === undefined) {
    return yield* new GoogleInvokerRejection({
      status: 401,
      reason: "invoker-not-configured",
    });
  }
  const token = bearerToken(request);
  if (token === undefined) {
    return yield* new GoogleInvokerRejection({
      status: 401,
      reason: "missing-bearer-token",
    });
  }

  const { payload } = yield* verifyToken(token, invoker);
  // jose accepts an audience array that contains the audience; Google signs
  // a single audience.
  if (payload.aud !== invoker.audience) {
    return yield* new GoogleInvokerRejection({
      status: 401,
      reason: "invalid-token",
      code: "ERR_JWT_CLAIM_VALIDATION_FAILED",
    });
  }
  if (payload.email !== invoker.email || payload.email_verified !== true) {
    return yield* new GoogleInvokerRejection({
      status: 403,
      reason: "unexpected-invoker",
    });
  }
});
