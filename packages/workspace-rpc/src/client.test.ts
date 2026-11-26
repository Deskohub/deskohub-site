import { describe, expect, test } from "bun:test";
import { Effect, Layer, Option, Redacted } from "effect";
import { FetchHttpClient, HttpRouter } from "effect/http";
import { RpcServer } from "effect/rpc";
import {
  BackendUnavailable,
  Caller,
  CallerContext,
  CampaignUnsubscribeRejected,
  CampaignUnsubscribeToken,
  decodeCallerHeaders,
  EmailPreferencesRpcs,
  layerCallerContextClient,
  layerWorkspaceRpcProtocol,
  MarketingManagementAccessToken,
  makeWorkspaceRpcClient,
  WorkspaceRpcSerialization,
} from "./index";

const payload = {
  token: CampaignUnsubscribeToken.make("synthetic-unsubscribe"),
};
const grant = {
  accessToken: MarketingManagementAccessToken.make(
    "synthetic-management-grant"
  ),
};
const caller = {
  correlationId: "72823c14-d2de-4a19-94ec-8b70ad590242",
  locale: "cs-CZ",
  clientAddress: Option.some("192.0.2.60"),
  userAgent: Option.some("Deskohub Fixture/1.0"),
} satisfies typeof Caller.Service;

const callerLayer = Layer.succeed(CallerContext)((effect, { headers }) =>
  decodeCallerHeaders(headers).pipe(
    Effect.flatMap((value) => Effect.provideService(effect, Caller, value))
  )
);

const handlers = EmailPreferencesRpcs.toLayer({
  "EmailPreferences.openPreferences": ({ token }) =>
    Effect.gen(function* () {
      expect(yield* Caller).toEqual(caller);
      return token === payload.token
        ? grant
        : yield* new CampaignUnsubscribeRejected();
    }),
  "EmailPreferences.unsubscribeOneClick": () => Effect.succeed("withdrawn"),
});

const makeTestServer = () =>
  HttpRouter.toWebHandler(
    RpcServer.layerHttp({
      group: EmailPreferencesRpcs,
      path: "/rpc",
      protocol: "http",
      disableFatalDefects: true,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(callerLayer, handlers, WorkspaceRpcSerialization)
      )
    )
  );

type Client = Effect.Success<ReturnType<typeof makeWorkspaceRpcClient>>;

const runClient = <A, E>(
  call: (client: Client) => Effect.Effect<A, E>,
  onFetch: (
    request: Request,
    init?: RequestInit
  ) => Response | Promise<Response>,
  authorization: Effect.Effect<
    Redacted.Redacted<string>,
    BackendUnavailable
  > = Effect.succeed(Redacted.make("synthetic-id-token")),
  invalidateAuthorization: (
    token: Redacted.Redacted<string>
  ) => Effect.Effect<void> = () => Effect.void
) => {
  const fetchStub = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) =>
      onFetch(new Request(input, init), init),
    { preconnect: () => {} }
  );
  const protocol = layerWorkspaceRpcProtocol({
    url: "https://workspace.invalid/",
    authorization,
    invalidateAuthorization,
  }).pipe(Layer.provide(FetchHttpClient.layer));
  return Effect.runPromise(
    makeWorkspaceRpcClient().pipe(
      Effect.flatMap(call),
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(protocol, layerCallerContextClient(caller))
      ),
      Effect.provideService(FetchHttpClient.Fetch, fetchStub)
    )
  );
};

const rpcContentType = "application/vnd.effect.rpc+schema-binary";

describe("Workspace RPC HTTP client", () => {
  test("sends a plain RPC URL and transports only validated caller metadata and token payloads", async () => {
    const server = makeTestServer();
    try {
      const result = await runClient(
        (client) => client.openPreferences(payload),
        async (request, init) => {
          expect(request.url).toEqual("https://workspace.invalid/rpc");
          expect(request.method).toBe("POST");
          expect(init?.redirect).toBe("manual");
          expect(request.headers.get("authorization")).toBe(
            "Bearer synthetic-id-token"
          );
          expect(request.headers.get("content-type")).toBe(rpcContentType);
          expect([...request.headers.values()].join(" ")).not.toContain(
            payload.token
          );
          expect(request.headers.get("x-deskohub-correlation-id")).toBeNull();
          request.headers.set("user-agent", "transport default");
          return server.handler(request);
        }
      );
      expect(result).toEqual(grant);
    } finally {
      await server.dispose();
    }
  });

  test("keeps declared campaign rejection as a typed failure", async () => {
    const server = makeTestServer();
    try {
      const failure = await runClient(
        (client) =>
          Effect.flip(
            client.openPreferences({
              token: CampaignUnsubscribeToken.make(""),
            })
          ),
        (request) => server.handler(request)
      );
      expect(failure).toBeInstanceOf(CampaignUnsubscribeRejected);
    } finally {
      await server.dispose();
    }
  });

  test("rejects a caller header injected at the HTTP transport boundary", async () => {
    const server = makeTestServer();
    try {
      const failure = await runClient(
        (client) => Effect.flip(client.openPreferences(payload)),
        (request) => {
          request.headers.set("x-deskohub-locale", caller.locale);
          return server.handler(request);
        }
      );
      expect(failure).toEqual(new BackendUnavailable({ reason: "caller" }));
    } finally {
      await server.dispose();
    }
  });

  for (const [status, contentType, reason] of [
    [429, rpcContentType, "http-status"],
    [503, "text/html", "http-status"],
    [200, "application/json", "content-type"],
    [200, `${rpcContentType}; charset=utf-8, text/html`, "content-type"],
  ] as const) {
    test(`rejects HTTP ${status} ${contentType} before reading the body`, async () => {
      let cancelled = false;
      const failure = await runClient(
        (client) => Effect.flip(client.openPreferences(payload)),
        () =>
          new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
            { status, headers: { "content-type": contentType } }
          )
      );
      expect(failure).toEqual(new BackendUnavailable({ reason, status }));
      expect(cancelled).toBe(true);
    });
  }

  test("maps a broken frame to backend unavailable", async () => {
    const failure = await runClient(
      (client) => Effect.flip(client.openPreferences(payload)),
      () =>
        new Response("bad frame", {
          headers: { "content-type": rpcContentType },
        })
    );
    expect(failure).toEqual(new BackendUnavailable({ reason: "protocol" }));
  });

  test("maps a failed token mint without issuing an HTTP request", async () => {
    const error = new BackendUnavailable({ reason: "authorization" });
    const failure = await runClient(
      (client) => Effect.flip(client.openPreferences(payload)),
      () => {
        throw new Error("Unexpected RPC HTTP request");
      },
      Effect.fail(error)
    );
    expect(failure).toBe(error);
  });

  test("evicts the rejected token and retries the same one-click request once", async () => {
    let minted = 0;
    const evicted: string[] = [];
    const sent: ArrayBuffer[] = [];
    const server = makeTestServer();
    try {
      const result = await runClient(
        (client) => client.unsubscribeOneClick(payload),
        async (request) => {
          sent.push(await request.clone().arrayBuffer());
          if (
            request.headers.get("authorization") === "Bearer synthetic-id-1"
          ) {
            return new Response("rejected", { status: 401 });
          }
          return server.handler(request);
        },
        Effect.sync(() => Redacted.make(`synthetic-id-${++minted}`)),
        (token) =>
          Effect.sync(() => {
            evicted.push(Redacted.value(token));
          })
      );
      expect(result).toBe("withdrawn");
      expect(evicted).toEqual(["synthetic-id-1"]);
      expect(minted).toBe(2);
      expect(sent[0]).toEqual(sent[1]);
    } finally {
      await server.dispose();
    }
  });

  test("evicts an ambiguously rejected token without replaying token issuance", async () => {
    let attempt = 0;
    const evicted: string[] = [];
    const failure = await runClient(
      (client) => Effect.flip(client.openPreferences(payload)),
      () => {
        attempt++;
        return new Response("rejected", { status: 401 });
      },
      undefined,
      (token) =>
        Effect.sync(() => {
          evicted.push(Redacted.value(token));
        })
    );
    expect(failure).toEqual(
      new BackendUnavailable({ reason: "http-status", status: 401 })
    );
    expect(evicted).toEqual(["synthetic-id-token"]);
    expect(attempt).toBe(1);
  });

  test("retries a Google front end IAM denial at most once", async () => {
    const tokens = [
      Redacted.make("synthetic-id-1"),
      Redacted.make("synthetic-id-2"),
    ];
    const evicted: Redacted.Redacted<string>[] = [];
    let attempt = 0;
    const failure = await runClient(
      (client) => Effect.flip(client.openPreferences(payload)),
      () =>
        new Response("denied", {
          status: 403,
          headers: { server: "Google Frontend", "content-type": "text/html" },
        }),
      Effect.sync(() => {
        const token = tokens[attempt++];
        if (!token) throw new Error("Unexpected mint");
        return token;
      }),
      (token) =>
        Effect.sync(() => {
          evicted.push(token);
        })
    );
    expect(failure).toEqual(
      new BackendUnavailable({ reason: "http-status", status: 403 })
    );
    expect(evicted).toHaveLength(1);
    expect(evicted[0]).toBe(tokens[0]);
    expect(attempt).toBe(2);
  });
});
