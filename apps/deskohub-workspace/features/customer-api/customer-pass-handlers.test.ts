import "@/shared/testing/workspace-test-env";

import { describe, expect, test } from "bun:test";
import { releaseGateForRunOverFlags } from "@/features/feature-flags/backend/release-cohorts.test-utils";
import { CoworkPassesReleaseGate } from "@/features/passes/backend/cowork-passes-release-gate";
import {
  answerInEachReleaseCohort,
  type CustomerApiCall,
  currentAccountResolving,
  customerApiRequest,
  expectEachCohortAnsweredAlone,
  inReleaseCohort,
  makeCustomerApiTestServer,
  testCustomerEndpointGuards,
} from "./customer-api.test-utils";

const catalog = { method: "GET", path: "/passes/catalog" } as const;
const passId = "019acbf0-0000-7000-8000-000000000011";

describe("customer pass reads", () => {
  testCustomerEndpointGuards(catalog);

  test("catalog answers only requests in the open release cohort", async () => {
    const answers = await answerInEachReleaseCohort({
      serve: (flags) =>
        makeCustomerApiTestServer({
          reservations: {
            currentAccount: currentAccountResolving((session) => ({
              kind: "profile-missing",
              session,
              reviewMarker: "absent",
            })),
          },
          passes: {
            release: releaseGateForRunOverFlags(CoworkPassesReleaseGate, flags),
          },
        }),
      send: (cohort) => customerApiRequest(inReleaseCohort(catalog, cohort)),
    });
    expectEachCohortAnsweredAlone(answers);
    expect(answers.alone.closed).toEqual({
      status: 404,
      body: { _tag: "CustomerPassesUnavailable" },
    });
    expect(answers.alone.open).toMatchObject({
      status: 200,
      body: {
        entryPacks: expect.arrayContaining([
          {
            product: { kind: "entry-pack", tier: "open-space", size: 5 },
            price: { value: 115000, exponent: 2, currency: "CZK" },
            validityMonths: 2,
          },
        ]),
      },
    });
  });

  for (const path of [
    "/passes",
    "/passes/options?date=2026-11-25&tier=open-space",
    `/passes/${passId}/access`,
    `/passes/reservation-funding?orderIds=${passId}`,
  ]) {
    test(`closed passes withhold ${path.split("?")[0]}`, async () => {
      const call: CustomerApiCall = { method: "GET", path };
      const api = makeCustomerApiTestServer();
      const response = await api.handle(customerApiRequest(call));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        _tag: "CustomerPassesUnavailable",
      });
    });
  }
});
