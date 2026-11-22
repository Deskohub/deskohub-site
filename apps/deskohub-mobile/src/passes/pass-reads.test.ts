import { expect, test } from "bun:test";
import {
  type CustomerPassList,
  CustomerReservationOrderId,
} from "@deskohub/workspace-customer-api";
import { Effect, Layer, Result } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { CustomerApi } from "../customer-api/customer-api.service";
import { nativeCustomerApiTransport } from "../customer-api/platform-transports";
import {
  makeCustomerDataRegistry,
  settle,
} from "../customer-api/testing/customer-data-test-registry";
import {
  fakeCustomerDataLayer,
  makeFakeDevice,
} from "../customer-api/testing/fake-customer-data";
import {
  FakeWorkspace,
  fakeWorkspaceOrigin,
} from "../customer-api/testing/fake-workspace";
import {
  heldPassesAtom,
  passCatalogAtom,
  resendPassInvitationAtom,
  reservationFundingAtom,
  unlimitedAccessAtom,
} from "./pass-reads";

const passId = "642ef6b9-48aa-495f-83a8-9a53f4791692";
const otherPassId = "c8459948-3d78-45bf-8876-c0f9310c52a2";
const orderId = CustomerReservationOrderId.make("sample-entry-pack-booking");
const period = {
  passId,
  tier: "reserved-desk",
  validFrom: "2026-11-08",
  lastUsableDate: "2026-12-07",
} as const;
const ownedPasses = {
  held: [
    {
      ...period,
      kind: "unlimited",
      status: "active",
      today: { date: "2026-11-22", day: 15, totalDays: 30 },
      seatLabel: "14",
      renewalPath: `/en-US/passes/unlimited?renew=${passId}`,
    },
  ],
  boughtForOthers: [
    {
      passId: otherPassId,
      product: { kind: "entry-pack", tier: "open-space", size: 5 },
      claimed: false,
      canResend: true,
      invitation: "sent",
      maskedHolderEmail: "s***@example.test",
    },
  ],
} satisfies CustomerPassList;

const harness = () => {
  const calls: Array<{ method: string; path: string; query: URLSearchParams }> =
    [];
  let invitationQueued = false;
  const transport = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) => {
      const path = url.pathname.replace(/^\/api\/customer\/passes\/?/, "");
      calls.push({ method: request.method, path, query: url.searchParams });
      const response = (body: unknown, status = 200) =>
        HttpClientResponse.fromWeb(request, Response.json(body, { status }));
      if (path === "") return Effect.succeed(response(ownedPasses));
      if (path === "catalog")
        return Effect.succeed(
          response({ _tag: "CustomerPassesUnavailable" }, 404)
        );
      if (path === `${passId}/access`) {
        return Effect.succeed(
          response({
            ...period,
            state: "available",
            date: "2026-11-22",
            day: 15,
            totalDays: 30,
            code: "000000000",
            endsAt: "2026-11-22T23:00:00Z",
            deskLabel: "14",
          })
        );
      }
      if (path === `${otherPassId}/invitation` && request.method === "POST") {
        invitationQueued = true;
        return Effect.succeed(response({ status: "queued" }));
      }
      if (path === "reservation-funding")
        return Effect.succeed(
          response({
            entryPackOrderIds: url.searchParams
              .getAll("orderIds")
              .includes(orderId)
              ? [orderId]
              : [],
          })
        );
      return Effect.succeed(response({ _tag: "CustomerPassNotFound" }, 404));
    })
  );
  const api = Layer.fresh(CustomerApi.Default).pipe(
    Layer.provide(
      nativeCustomerApiTransport({
        apiOrigin: fakeWorkspaceOrigin,
        readSessionCookie: Effect.succeed("deskohub.session_token=sample"),
      })
    ),
    Layer.provide(transport)
  );
  const registry = makeCustomerDataRegistry(
    Layer.mergeAll(
      fakeCustomerDataLayer({
        workspace: FakeWorkspace.forKind("linked"),
        device: makeFakeDevice(),
      }),
      api
    )
  );
  return { registry, calls, wasQueued: () => invitationQueued };
};

test("the signed-in reads expose owned periods, the existing renewal path and masked gift metadata", async () => {
  const { registry, calls } = harness();
  try {
    const held = await settle(registry, heldPassesAtom("en-US"));
    expect(held).toEqual(Result.succeed(ownedPasses));
    expect(calls[0]?.query.get("locale")).toBe("en-US");
    expect(held).not.toHaveProperty("success.boughtForOthers.0.recipientEmail");
    const access = await settle(registry, unlimitedAccessAtom(passId));
    expect(access).toMatchObject({
      _tag: "Success",
      success: { state: "available", deskLabel: "14" },
    });
    const other = await settle(registry, unlimitedAccessAtom(otherPassId));
    expect(other).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "CustomerPassNotFound" },
    });
  } finally {
    registry.dispose();
  }
});

test("the pass reads keep release closure and reservation funding out of the legacy history response", async () => {
  const { registry, calls } = harness();
  try {
    const catalog = await settle(registry, passCatalogAtom);
    expect(catalog).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "CustomerPassesUnavailable" },
    });
    const otherIds = Array.from({ length: 50 }, (_, n) =>
      CustomerReservationOrderId.make(`sample-booking-${n}`)
    );
    const funding = await settle(
      registry,
      reservationFundingAtom([orderId, ...otherIds])
    );
    expect(funding).toEqual(Result.succeed(new Set([orderId])));
    expect(
      calls
        .filter(({ path }) => path === "reservation-funding")
        .map(({ query }) => query.getAll("orderIds").length)
    ).toEqual([50, 1]);
  } finally {
    registry.dispose();
  }
});

test("resend uses the gift ID and refreshes the account's list", async () => {
  const { registry, calls, wasQueued } = harness();
  try {
    const unmount = registry.mount(heldPassesAtom("en-US"));
    await settle(registry, heldPassesAtom("en-US"));
    const unmountWrite = registry.mount(resendPassInvitationAtom);
    registry.set(resendPassInvitationAtom, {
      passId: otherPassId,
      locale: "en-US",
    });
    const write = await settle(registry, resendPassInvitationAtom);
    expect(write).toEqual(Result.succeed({ status: "queued" }));
    await settle(registry, heldPassesAtom("en-US"));
    expect(wasQueued()).toBe(true);
    expect(calls.map(({ method, path }) => [method, path])).toEqual([
      ["GET", ""],
      ["POST", `${otherPassId}/invitation`],
      ["GET", ""],
    ]);
    unmountWrite();
    unmount();
  } finally {
    registry.dispose();
  }
});
