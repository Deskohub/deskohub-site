import { expect, mock, spyOn, test } from "bun:test";
import { RegistryContext } from "@effect/atom-react";
import { Effect, Layer, Result } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import type { AtomRegistry } from "effect/reactivity";
import type { ReactElement } from "react";
import { CustomerApi } from "../../customer-api/customer-api.service";
import { accountAtom } from "../../customer-api/customer-data-runtime";
import { nativeCustomerApiTransport } from "../../customer-api/platform-transports";
import {
  makeCustomerDataRegistry,
  makeFakeCustomerData,
  settle,
} from "../../customer-api/testing/customer-data-test-registry";
import {
  fakeCustomerDataLayer,
  makeFakeDevice,
} from "../../customer-api/testing/fake-customer-data";
import {
  FakeWorkspace,
  fakeWorkspaceHttpClient,
  fakeWorkspaceOrigin,
} from "../../customer-api/testing/fake-workspace";
import { withSampleHistory } from "../../customer-api/testing/sample-history";
import { AppLocaleProvider } from "../../i18n/locale-context";
import { m } from "../../i18n/messages";
import { heldPassesAtom, passCatalogAtom } from "../../passes/pass-reads";
import { expoRouterStandIn } from "../../testing/expo-router-stand-in";
import { findAll, hostTree, textOf } from "../../ui/testing/element-tree";
import { invitedReservationsAtom } from "./invited-reservations";
import { reservationHistoryAtom } from "./reservations-list-state";

mock.module("expo-router", () => expoRouterStandIn());

const { ReservationsListScreen } = await import("./reservations-list-screen");
const { ToastProvider } = await import("../../ui/toast");

const screenText = (registry: AtomRegistry.AtomRegistry) => {
  const within = (node: ReactElement) => (
    <RegistryContext.Provider value={registry}>
      <AppLocaleProvider locale="en-US">
        <ToastProvider>{node}</ToastProvider>
      </AppLocaleProvider>
    </RegistryContext.Provider>
  );
  const { error } = console;
  const warnings = spyOn(console, "error").mockImplementation((...args) => {
    if (!/incorrect casing|does not recognize the/.test(String(args[0])))
      error(...args);
  });
  try {
    return findAll(hostTree(<ReservationsListScreen />, within), "Text")
      .map(textOf)
      .join("\n");
  } finally {
    warnings.mockRestore();
  }
};

test.each(["completion-required", "linked"] as const)(
  "lists invitations independently of own history for a %s account",
  async (kind) => {
    const sample = FakeWorkspace.forKind(kind).data;
    const invitation = sample.invited?.current[0];
    if (!invitation?.bookedBy.name) throw new Error("Expected a sample invite");
    const workspace = new FakeWorkspace(sample);
    if (kind === "linked") withSampleHistory(workspace, "cancelled-invitation");
    workspace.fail("listReservations", "service-unavailable");
    const { registry } = makeFakeCustomerData(kind, workspace);

    const releaseAccount = registry.mount(accountAtom);
    const releaseInvitations = registry.mount(invitedReservationsAtom);
    const releaseHistory =
      kind === "linked" ? registry.mount(reservationHistoryAtom) : undefined;
    try {
      await settle(registry, accountAtom);
      expect(
        Result.isSuccess(await settle(registry, invitedReservationsAtom))
      ).toBe(true);
      if (kind === "linked") {
        expect(
          Result.isFailure(await settle(registry, reservationHistoryAtom))
        ).toBe(true);
      } else {
        expect(workspace.calls).not.toContain("listReservations");
      }
      const text = screenText(registry);
      expect(text).toContain(invitation.bookedBy.name);
      const cancelled = m.reservationStatusCancelled({}, { locale: "en-US" });
      if (kind === "linked") {
        expect(text).toContain(cancelled);
      } else {
        expect(text).not.toContain(cancelled);
      }
    } finally {
      releaseAccount();
      releaseInvitations();
      releaseHistory?.();
      registry.dispose();
    }
  }
);

test("empty history shows a pass catalog outage and retry restores the Unlimited period", async () => {
  const workspace = FakeWorkspace.forKind("linked");
  const base = fakeCustomerDataLayer({ workspace, device: makeFakeDevice() });
  const locale = "en-US" as const;
  let catalogAvailable = false;
  const transport = Layer.effect(
    HttpClient.HttpClient,
    Effect.map(Effect.service(HttpClient.HttpClient), (fallback) =>
      HttpClient.make((request, url) => {
        const respond = (body: unknown, status = 200) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(request, Response.json(body, { status }))
          );
        switch (url.pathname.replace(/\/$/, "")) {
          case "/api/customer/reservations":
            return respond({ current: [], past: [], unavailable: [] });
          case "/api/customer/passes/catalog":
            return catalogAvailable
              ? respond({
                  entryPacks: [],
                  unlimited: [],
                  unlimitedCoffeePrice: {
                    currency: "CZK",
                    value: 0,
                    exponent: 2,
                  },
                })
              : respond({ _tag: "CustomerServiceUnavailable" }, 503);
          case "/api/customer/passes":
            return respond({
              held: [
                {
                  kind: "unlimited",
                  status: "active",
                  tier: "reserved-desk",
                  passId: "dd7dea68-2624-4ed3-acf5-7d3f2d4a8427",
                  validFrom: "2026-11-08",
                  lastUsableDate: "2026-12-07",
                  today: { date: "2026-11-22", day: 15, totalDays: 30 },
                },
              ],
              boughtForOthers: [],
            });
          default:
            return fallback.execute(request);
        }
      })
    )
  ).pipe(Layer.provide(fakeWorkspaceHttpClient(workspace)));
  const api = Layer.fresh(CustomerApi.Default).pipe(
    Layer.provide(
      nativeCustomerApiTransport({
        apiOrigin: fakeWorkspaceOrigin,
        readSessionCookie: Effect.succeed(""),
      })
    ),
    Layer.provide(transport)
  );
  const registry = makeCustomerDataRegistry(Layer.mergeAll(base, api));
  const release = [
    registry.mount(accountAtom),
    registry.mount(reservationHistoryAtom),
    registry.mount(passCatalogAtom),
    registry.mount(heldPassesAtom(locale)),
  ];
  try {
    await settle(registry, accountAtom);
    await settle(registry, reservationHistoryAtom);
    await settle(registry, passCatalogAtom);
    const outage = screenText(registry);
    expect(outage).toContain(m.passes_load_failed({}, { locale }));
    expect(outage).toContain(m.account_retry({}, { locale }));
    expect(outage).not.toContain(m.reservations_none_yet({}, { locale }));

    catalogAvailable = true;
    registry.refresh(passCatalogAtom);
    await settle(registry, passCatalogAtom);
    await settle(registry, heldPassesAtom(locale));
    const recovered = screenText(registry);
    expect(recovered).toContain(m.passes_door_code({}, { locale }));
    expect(recovered).not.toContain(m.passes_load_failed({}, { locale }));
  } finally {
    for (const dispose of release) dispose();
    registry.dispose();
  }
});
