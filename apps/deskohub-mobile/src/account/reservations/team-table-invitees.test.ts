import { expect, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import {
  CustomerReservationInviteeId,
  CustomerReservationOrderId,
  type CustomerTeamTableStatus,
} from "@deskohub/workspace-customer-api";
import { Effect, Option } from "effect";
import {
  fakeCustomerDataLayer,
  makeFakeDevice,
} from "../../customer-api/testing/fake-customer-data";
import { FakeWorkspace } from "../../customer-api/testing/fake-workspace";
import { sampleOrderIds } from "../../customer-api/testing/sample-fixtures";
import { readOrderStatus } from "./order-status-state";
import type { ReservationListRow } from "./reservation-list-model";
import {
  addTeamTableInvitee,
  teamTableInviteeAdditionEndsAt,
} from "./team-table-invitees";

const order: CustomerTeamTableStatus = {
  orderId: CustomerReservationOrderId.make("team-table-invitees-order"),
  kind: "table",
  status: "fulfilled",
  paymentStatus: "paid",
  fulfillmentStatus: "fulfilled",
  startsAt: "2026-11-30T09:00:00Z",
  endsAt: "2026-11-30T10:00:00Z",
  product: { kind: "table", seats: 2, durationMinutes: 60 },
  people: {
    contactAttends: false,
    resendable: true,
    invitees: [
      {
        id: CustomerReservationInviteeId.make("team-table-invitee"),
        email: testEmailAddress("invitee"),
        invitationSentAt: null,
      },
    ],
  },
};

const row: ReservationListRow = {
  id: order.orderId,
  orderId: order.orderId,
  product: { kind: "other", family: "table" },
  startsAt: order.startsAt ?? null,
  endsAt: order.endsAt ?? null,
  seats: 2,
  status: "confirmed",
};

test("a confirmed booker can add an invitee until the booked end if a seat remains", () => {
  const end = Date.parse("2026-11-30T10:00:00Z");
  expect(teamTableInviteeAdditionEndsAt(order, Option.some(row))).toBe(end);
  expect(
    teamTableInviteeAdditionEndsAt(
      order,
      Option.some({ ...row, party: { kind: "booked-for", customerName: null } })
    )
  ).toBe(end);
  expect(
    teamTableInviteeAdditionEndsAt(
      { ...order, people: { ...order.people!, contactAttends: true } },
      Option.some(row)
    )
  ).toBeUndefined();
});

test("add invitee requires a confirmed reservation and fresh booker history", () => {
  expect(teamTableInviteeAdditionEndsAt(order, Option.none())).toBeUndefined();
  expect(
    teamTableInviteeAdditionEndsAt(
      order,
      Option.some({ ...row, party: { kind: "booked-by", authorName: null } })
    )
  ).toBeUndefined();
  expect(
    teamTableInviteeAdditionEndsAt(
      { ...order, status: "pending", paymentStatus: "pending" },
      Option.some(row)
    )
  ).toBeUndefined();
});

test("the dedicated Team Table status reflects one successful invite and typed rejections", async () => {
  const workspace = FakeWorkspace.forKind("linked");
  const id = sampleOrderIds.teamTable;
  const newEmail = testEmailAddress("new-guest");
  const add = (email: string) => addTeamTableInvitee(id, "en-US", email);
  const result = await Effect.gen(function* () {
    const before = yield* readOrderStatus(id);
    const invalid = yield* add("invalid");
    const duplicate = yield* add(
      testEmailAddress("team.table.guest").toUpperCase()
    );
    const added = yield* add(newEmail);
    const after = yield* readOrderStatus(id, "table");
    const full = yield* add(testEmailAddress("another"));
    return { before, invalid, duplicate, added, after, full };
  }).pipe(
    Effect.provide(
      fakeCustomerDataLayer({ workspace, device: makeFakeDevice() })
    ),
    Effect.runPromise
  );
  expect(result.before.kind).toBe("table");
  expect(result.invalid).toBe("invalid-email");
  expect(result.duplicate).toBe("duplicate");
  expect(result.added).toBe("added");
  expect(result.after.people?.invitees.map(({ email }) => email)).toContain(
    newEmail
  );
  expect(result.full).toBe("capacity");
  expect(
    workspace.calls.filter(
      (call) => call === "getReservationStatus" || call === "getStatus"
    )
  ).toEqual(["getReservationStatus", "getStatus", "getStatus"]);
});

test("a legacy status error other than not-found does not fall back", async () => {
  const workspace = FakeWorkspace.forKind("linked");
  workspace.fail("getReservationStatus", "rate-limited");
  const result = await readOrderStatus(sampleOrderIds.fulfilled).pipe(
    Effect.provide(
      fakeCustomerDataLayer({ workspace, device: makeFakeDevice() })
    ),
    Effect.result,
    Effect.runPromise
  );
  expect(result._tag).toBe("Failure");
  expect(workspace.calls).toEqual(["getReservationStatus"]);
});
