import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import { Effect, Layer } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { CustomerAccountSections } from "@/features/account/backend/customer-account-sections";
import {
  type CustomerAccountSession,
  CustomerAuthentication,
} from "@/features/account/backend/customer-authentication.service";
import {
  type CustomerAccountId,
  customerAccountIdSchema,
} from "@/features/account/customer-account";
import { m } from "@/features/i18n";
import { type OrderId, orderIdSchema } from "@/features/order";
import { CoworkPassesReleaseGate } from "@/features/passes/backend/cowork-passes-release-gate";
import { reservationCustomerEmailSchema } from "@/features/reservation/reservation-contact";
import { mockWorkspaceActionRequest } from "@/shared/testing/workspace-action-request.test-utils";

await mockWorkspaceActionRequest();

let previewEnabled = true;
let passesReleased = true;
mock.module(
  "@/features/passes/backend/unlimited-auto-renewal-preview.server",
  () => ({ isUnlimitedAutoRenewalPreviewEnabled: () => previewEnabled })
);
mock.module(
  "@/features/passes/backend/cowork-passes-release-gate.server",
  () => ({
    CoworkPassesReleaseGateRequest: CoworkPassesReleaseGate.fromEvaluation(
      Effect.sync(() => passesReleased)
    ),
  })
);

const accountId = customerAccountIdSchema.make("fixture-renewal-owner");
const orderId = orderIdSchema.make(crypto.randomUUID());
const now = Temporal.Instant.from("2026-11-26T00:00:00Z");
const customer = {
  accountId,
  email: reservationCustomerEmailSchema.make(testEmailAddress("renewal-owner")),
  deletionRequested: false,
  displayName: null,
  accountCreatedAt: now,
  accountUpdatedAt: now,
} satisfies CustomerAccountSession;

let session: CustomerAccountSession | null;
const authentication = CustomerAuthentication.Default;
const sections = CustomerAccountSections.ForProvidedAuthentication;
const database = WorkspaceDatabase.Default;
Object.assign(CustomerAuthentication, {
  Default: Layer.succeed(CustomerAuthentication, {
    currentUser: Effect.sync(() => session),
  }),
});
Object.assign(CustomerAccountSections, {
  ForProvidedAuthentication: Layer.mock(CustomerAccountSections, {}),
});
Object.assign(WorkspaceDatabase, {
  Default: Layer.mock(WorkspaceDatabase, {}),
});

const cancel = mock((_accountId: CustomerAccountId, _orderId: OrderId) =>
  Effect.succeed("cancelled" as const)
);
mock.module("@/features/passes/backend/unlimited-auto-renewal", () => ({
  cancelUnlimitedAutoRenewal: cancel,
}));

const { cancelAccountUnlimitedAutoRenewal } = await import(
  "./unlimited-auto-renewal-actions"
);

beforeEach(() => {
  previewEnabled = true;
  passesReleased = true;
  session = customer;
  cancel.mockClear();
});

afterAll(() => {
  Object.assign(CustomerAuthentication, { Default: authentication });
  Object.assign(CustomerAccountSections, {
    ForProvidedAuthentication: sections,
  });
  Object.assign(WorkspaceDatabase, { Default: database });
});

test("uses the authoritative customer's account ID to cancel the submitted order", async () => {
  expect(await cancelAccountUnlimitedAutoRenewal({ orderId })).toEqual({
    data: { status: "cancelled" },
  });
  expect(cancel).toHaveBeenCalledWith(accountId, orderId);
});

test("refuses cancellation without a verified session", async () => {
  session = null;
  expect(await cancelAccountUnlimitedAutoRenewal({ orderId })).toEqual({
    serverError: m.accountSessionExpired({}, { locale: "en-US" }),
  });
  expect(cancel).not.toHaveBeenCalled();
});

test("refuses cancellation outside the renewal preview or the passes release", async () => {
  previewEnabled = false;
  expect(await cancelAccountUnlimitedAutoRenewal({ orderId })).toEqual({
    data: { status: "unavailable" },
  });

  previewEnabled = true;
  passesReleased = false;
  expect(await cancelAccountUnlimitedAutoRenewal({ orderId })).toEqual({
    data: { status: "unavailable" },
  });
  expect(cancel).not.toHaveBeenCalled();
});

test("rejects an account ID supplied with an otherwise valid order", async () => {
  const input = { orderId, accountId: "fixture-other-account" };
  expect(
    (await cancelAccountUnlimitedAutoRenewal(input)).validationErrors
  ).toBeDefined();
  expect(cancel).not.toHaveBeenCalled();
});
