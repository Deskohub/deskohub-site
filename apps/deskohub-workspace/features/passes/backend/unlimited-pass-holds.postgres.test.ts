import "@/shared/testing/workspace-test-env";

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  DotyposCustomerIdSchema,
  DotyposRejected,
  type DotyposReservationId,
  DotyposService,
  DotyposTableIdSchema,
  DotyposTableSchema,
  DotyposUnavailable,
  DotyposUncertain,
} from "@deskohub/dotypos";
import { makeInMemoryDotypos } from "@deskohub/dotypos/testing";
import { EmailDeliveryIdSchema } from "@deskohub/email";
import { testEmailAddress } from "@deskohub/test-email";
import { eq } from "drizzle-orm";
import { Deferred, Effect, Fiber, Layer, Result, Schema } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { WorkspaceDatabaseAdvisoryLock } from "@/db/postgres-advisory-lock";
import {
  customerAccounts,
  orders,
  passPurchases,
  paymentAttempts,
  workspaceReservations,
} from "@/db/schema";
import { WorkspaceLockSections } from "@/db/workspace-locks";
import { CurrentCustomerAccount } from "@/features/account/backend/current-customer-account";
import { CustomerAccountContactService } from "@/features/account/backend/customer-account-contact.service";
import {
  CustomerAccountSections,
  HeldCustomerAccount,
} from "@/features/account/backend/customer-account-sections";
import { testSessionProfile } from "@/features/account/backend/customer-authentication.test-utils";
import { customerAccountIdSchema } from "@/features/account/customer-account";
import { WorkspaceTableAssignmentService } from "@/features/checkout/backend/reservation/workspace-table-assignment.service";
import { paymentAttemptIdSchema } from "@/features/checkout/checkout-identifiers";
import { DiscountService } from "@/features/discounts/discount.service";
import { WorkspaceFeatureFlagService } from "@/features/feature-flags/backend/workspace-feature-flag.service";
import { orderIdSchema } from "@/features/order";
import { GoogleCalendarWorkspaceLimitationsService } from "@/features/reservation/backend/google-calendar-workspace-limitations.service";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import { getCurrentWorkspaceDate } from "@/features/reservation/reservation-date";
import {
  deliveryReportEmailId,
  deliveryReportEventId,
} from "@/shared/backend/email/delivery-reports";
import { currencyCZK } from "@/shared/money/currencies";
import { fixtureReservationAuthorId } from "@/shared/testing/workspace-fixtures.test-utils";
import {
  createWorkspacePostgresSuiteDatabase,
  type WorkspacePostgresSuiteDatabase,
} from "@/shared/testing/workspace-postgres-test-database.test-utils";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import {
  ambiguousPassDayHoldCode,
  formatPassDayMarker,
  rejectedPassDayHoldCode,
} from "../pass-day-marker";
import { unlimitedPassDays } from "../pass-offer";
import { settlePassPurchase } from "./entry-pack-settlement";
import { unlimitedConfirmationDeliveryReports } from "./unlimited-confirmation-delivery";
import { getBookableUnlimitedStarts } from "./unlimited-pass-capacity";
import {
  confirmUnlimitedPassDays,
  createUnlimitedPassHolds,
  readUnlimitedPassDays,
  reconfirmUnlimitedPassHolds,
  releaseUnlimitedPassDays,
} from "./unlimited-pass-holds";
import {
  recordReplacementUnlimitedPassHolds,
  recordUnlimitedPassOrder,
} from "./unlimited-pass-orders";
import { beginUnlimitedPassPurchase } from "./unlimited-pass-purchase";
import { prepareUnlimitedPassRecovery } from "./unlimited-pass-recovery";

let database: WorkspacePostgresSuiteDatabase | null;
beforeEach(async () => {
  database = await createWorkspacePostgresSuiteDatabase("unlimited_holds");
});
afterEach(async () => {
  await database?.close();
});

const it = test.skipIf(!process.env.WORKSPACE_TEST_DATABASE_URL);
const customerId = DotyposCustomerIdSchema.make("123");
const tableId = DotyposTableIdSchema.make("42");
const date = (value: Temporal.PlainDate) =>
  plainDateStringSchema.make(value.toString());
const newAccountId = () => customerAccountIdSchema.make(crypto.randomUUID());

const record = (
  start: Temporal.PlainDate,
  buyer = newAccountId(),
  holder = fixtureReservationAuthorId
) =>
  Effect.gen(function* () {
    const { db, transaction } = yield* WorkspaceDatabase;
    yield* db.insert(customerAccounts).values({ id: buyer });
    return yield* transaction(
      recordUnlimitedPassOrder({
        orderId: orderIdSchema.make(crypto.randomUUID()),
        locale: "en-US",
        buyer: { accountId: buyer, customerId },
        holder: { accountId: holder, customerId },
        createdAt: Temporal.Now.instant(),
        selection: { startDate: date(start), tier: "reserved-desk" },
        quote: {
          product: { kind: "unlimited", tier: "reserved-desk" },
          discountableSubtotal: currencyCZK(599_000),
          discountedSubtotal: currencyCZK(599_000),
          totalDiscount: currencyCZK(0),
          discounts: [],
        },
        days: Array.from({ length: unlimitedPassDays }, (_, index) => ({
          serviceDate: date(start.add({ days: index })),
          tableId,
        })),
      })
    );
  });

const expirePass = Effect.fnUntraced(function* (
  orderId: typeof orders.$inferSelect.id
) {
  const { db } = yield* WorkspaceDatabase;
  const attemptId = paymentAttemptIdSchema.make(crypto.randomUUID());
  yield* db.insert(paymentAttempts).values({
    id: attemptId,
    orderId,
    provider: "mock",
    providerOrderId: attemptId,
    state: "expired",
    failureCode: "fixture_expired",
    amountValue: 599_000,
    amountExponent: 2,
    currency: "CZK",
  });
  yield* db
    .update(orders)
    .set({ paymentState: "expired", activePaymentAttemptId: attemptId })
    .where(eq(orders.id, orderId));
  yield* settlePassPurchase(orderId);
  return attemptId;
});

it("serializes overlapping entitlement purchases for the same holder", async () => {
  const start = getCurrentWorkspaceDate().add({ days: 60 });
  const results = await Effect.runPromise(
    Effect.all(
      [
        Effect.result(record(start)),
        Effect.result(record(start.add({ days: 1 }))),
      ],
      { concurrency: 2 }
    ).pipe(Effect.provide(database!.layer))
  );
  expect(results.filter(Result.isSuccess)).toHaveLength(1);
  expect(
    results.filter(Result.isFailure).map((result) => result.failure)
  ).toEqual([expect.objectContaining({ reason: "overlapping-pass" })]);
});

it("records the earliest verified buyer delivery for the winning attempt only", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const purchase = yield* record(
        getCurrentWorkspaceDate().add({ days: 100 })
      );
      const { db } = yield* WorkspaceDatabase;
      const attemptId = paymentAttemptIdSchema.make(crypto.randomUUID());
      const paidAt = Temporal.Instant.from("2026-11-20T10:00:00Z");
      yield* db.insert(paymentAttempts).values({
        id: attemptId,
        orderId: purchase.id,
        provider: "internal",
        state: "paid",
        amountValue: 0,
        amountExponent: 2,
        currency: "CZK",
      });
      yield* db
        .update(orders)
        .set({
          paymentState: "paid",
          paidAt,
          activePaymentAttemptId: attemptId,
        })
        .where(eq(orders.id, purchase.id));

      const report = (
        minutes: number,
        paymentId: string,
        deployment = "preview"
      ) =>
        unlimitedConfirmationDeliveryReports.receive({
          eventId: deliveryReportEventId(`fixture-delivery-${minutes}`),
          event: "email.delivered",
          emailId: deliveryReportEmailId(
            EmailDeliveryIdSchema.make("fixture-email")
          ),
          occurredAt: paidAt.add({ minutes }),
          tags: new Map([
            ["orderId", purchase.id],
            ["paymentAttemptId", paymentId],
            ["deploymentEnvironment", deployment],
          ]),
          deploymentEnvironment: "preview",
        });
      expect((yield* report(1, "obsolete-attempt")).status).toBe("ignored");
      expect((yield* report(2, attemptId, "production")).status).toBe(
        "ignored"
      );
      expect((yield* report(8, attemptId)).status).toBe("processed");
      expect((yield* report(4, attemptId)).status).toBe("processed");
      expect((yield* report(10, attemptId)).status).toBe("processed");
      const [recorded] = yield* db
        .select({ deliveredAt: passPurchases.buyerConfirmationDeliveredAt })
        .from(passPurchases)
        .where(eq(passPurchases.id, purchase.id));
      expect(recorded?.deliveredAt?.equals(paidAt.add({ minutes: 4 }))).toBe(
        true
      );
    }).pipe(Effect.provide(database!.layer))
  );
});

it("reacquires all provider holds on the original rows after terminal payment", async () => {
  const testDatabase = (await createWorkspacePostgresSuiteDatabase(
    "unlimited_recovery"
  ))!;
  const table = Schema.decodeUnknownSync(DotyposTableSchema)({
    id: tableId,
    _cloudId: "1",
    display: true,
    enabled: true,
    name: "Synthetic reserved desk",
    seats: "1",
    tags: ["cowork:reserved-desk"],
  });
  const provider = makeInMemoryDotypos({ tables: [table] });
  const services = Layer.mergeAll(
    testDatabase.layer,
    provider.layer,
    WorkspaceDatabaseAdvisoryLock.makeLayer(testDatabase.databasePool),
    WorkspaceReservationRepository.Default.pipe(
      Layer.provide(testDatabase.layer)
    ),
    Layer.mock(GoogleCalendarWorkspaceLimitationsService, {
      listLimitations: () => Effect.succeed([]),
    })
  );

  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const purchase = yield* record(
          getCurrentWorkspaceDate().add({ days: 140 })
        );
        yield* createUnlimitedPassHolds(purchase);
        const initial = yield* readUnlimitedPassDays(purchase.id);
        const attemptId = yield* expirePass(purchase.id);

        const restored = yield* prepareUnlimitedPassRecovery(
          purchase.id,
          attemptId
        ).pipe(WorkspaceLockSections.unlimitedPassRecovery(purchase.id));
        expect(restored).toBe(true);
        const replaced = yield* readUnlimitedPassDays(purchase.id);
        expect(replaced.map(({ id }) => id)).toEqual(
          initial.map(({ id }) => id)
        );
        expect(
          replaced.every(
            (row, index) =>
              row.dotyposReservationId !== initial[index]?.dotyposReservationId
          )
        ).toBe(true);
        const providerRecords = [...provider.reservations.values()];
        expect(
          providerRecords.filter((record) => record.status === "NEW")
        ).toHaveLength(unlimitedPassDays);
        expect(
          providerRecords.filter((record) => record.status === "CANCELLED")
        ).toHaveLength(unlimitedPassDays);
      }).pipe(Effect.provide(services))
    );
  } finally {
    await testDatabase.close();
  }
});

it("releases a definitively rejected POST and retains an interrupted POST", async () => {
  const provider = makeInMemoryDotypos({});
  const start = getCurrentWorkspaceDate().add({ days: 200 });
  const rejected = new DotyposRejected({
    operation: "createReservation",
    reason: "invalid-request",
  });
  const layer = database!.layer;

  await Effect.runPromise(
    Effect.gen(function* () {
      const purchase = yield* record(start);
      const [first, second] = yield* readUnlimitedPassDays(purchase.id);
      const createReservation: typeof provider.service.createReservation = (
        input
      ) =>
        input.note?.includes(`/${first!.serviceDate}/`)
          ? Effect.fail(rejected)
          : provider.service.createReservation(input);
      const failed = yield* Effect.result(
        createUnlimitedPassHolds(purchase)
      ).pipe(
        Effect.provideService(DotyposService, {
          ...provider.service,
          createReservation,
        })
      );
      expect(failed).toEqual(Result.fail(rejected));
      const [released, held] = yield* readUnlimitedPassDays(purchase.id);
      expect(released).toMatchObject({
        id: first!.id,
        failureCode: rejectedPassDayHoldCode,
        reservationState: "hold_expired",
        dotyposReservationId: null,
        passDayHoldGeneration: expect.any(String),
      });
      expect(held).toMatchObject({ id: second!.id, reservationState: "held" });
      yield* releaseUnlimitedPassDays(purchase);
      expect(
        (yield* readUnlimitedPassDays(purchase.id))[0]?.reservationState
      ).toBe("hold_expired");

      const interrupted = yield* record(start.add({ days: 40 }));
      const attempted = yield* Effect.exit(
        createUnlimitedPassHolds(interrupted)
      ).pipe(
        Effect.provideService(DotyposService, {
          ...provider.service,
          createReservation: () => Effect.interrupt,
        })
      );
      expect(attempted._tag).toBe("Failure");
      const requested = (yield* readUnlimitedPassDays(interrupted.id)).filter(
        (row) => row.passDayHoldRequestedAt !== null
      );
      expect(requested.length).toBeGreaterThan(0);
      yield* releaseUnlimitedPassDays(interrupted);
      const remaining = (yield* readUnlimitedPassDays(interrupted.id)).filter(
        (row) => row.reservationState === "creating_hold"
      );
      expect(
        remaining.map(({ id, passDayHoldGeneration }) => ({
          id,
          passDayHoldGeneration,
        }))
      ).toEqual(
        requested.map(({ id, passDayHoldGeneration }) => ({
          id,
          passDayHoldGeneration,
        }))
      );
    }).pipe(Effect.provide(Layer.mergeAll(layer, provider.layer)))
  );
});

it("keeps a timed-out replacement claimed while only the cancelled original is visible", async () => {
  const provider = makeInMemoryDotypos({});
  const start = getCurrentWorkspaceDate().add({ days: 290 });
  let hidden: DotyposReservationId | undefined;

  await Effect.runPromise(
    Effect.gen(function* () {
      const purchase = yield* record(start);
      yield* createUnlimitedPassHolds(purchase);
      const original = yield* readUnlimitedPassDays(purchase.id);
      const first = original[0]!;

      // One day represents a hold created by the previous deployment.
      const { db, transaction } = yield* WorkspaceDatabase;
      yield* db
        .update(workspaceReservations)
        .set({ passDayHoldGeneration: null })
        .where(eq(workspaceReservations.id, first.id));
      const originalRecord = provider.reservations.get(
        first.dotyposReservationId!
      )!;
      provider.reservations.set(originalRecord.id, {
        ...originalRecord,
        note: formatPassDayMarker(purchase.id, start, null),
      });
      yield* reconfirmUnlimitedPassHolds(purchase);

      const paidAttemptId = yield* expirePass(purchase.id);
      const retired = { ...purchase, status: "void" } as const;
      yield* releaseUnlimitedPassDays(retired);
      const replacement = yield* transaction(
        recordReplacementUnlimitedPassHolds({
          purchase: retired,
          paidAttemptId,
          days: original.map(({ serviceDate, passDayTableId }) => ({
            serviceDate,
            tableId: passDayTableId,
          })),
          now: Temporal.Now.instant(),
        })
      );
      const replacementService = {
        ...provider.service,
        createReservation: (
          input: Parameters<typeof provider.service.createReservation>[0]
        ) =>
          Effect.gen(function* () {
            if (!input.note?.includes(`/${first.serviceDate}/`)) {
              return yield* provider.service.createReservation(input);
            }
            const [journaled] = yield* db
              .select()
              .from(workspaceReservations)
              .where(eq(workspaceReservations.id, first.id))
              .pipe(Effect.orDie);
            expect(journaled?.passDayHoldRequestedAt).toBeDefined();
            expect(journaled?.passDayHoldRequestedAt).not.toBeNull();
            expect(input.note).toContain(journaled!.passDayHoldGeneration!);
            const created = yield* provider.service.createReservation(input);
            hidden = created.id;
            return yield* new DotyposUncertain({
              operation: "createReservation",
              reason: "timeout",
            });
          }),
        listReservations: (
          ...args: Parameters<typeof provider.service.listReservations>
        ) =>
          provider.service
            .listReservations(...args)
            .pipe(
              Effect.map((records) => records.filter(({ id }) => id !== hidden))
            ),
      };
      const outcome = yield* Effect.result(
        createUnlimitedPassHolds(replacement)
      ).pipe(Effect.provideService(DotyposService, replacementService));
      expect(outcome).toEqual(
        Result.fail(expect.objectContaining({ _tag: "DotyposUncertain" }))
      );
      const [pending] = yield* readUnlimitedPassDays(purchase.id);
      const replacementId = hidden!;
      expect(provider.reservations.get(replacementId)?.note).toContain(
        pending!.passDayHoldGeneration!
      );
      expect(provider.reservations.get(originalRecord.id)?.status).toBe(
        "CANCELLED"
      );
      yield* releaseUnlimitedPassDays(replacement).pipe(
        Effect.provideService(DotyposService, replacementService)
      );
      const [stillPending] = yield* readUnlimitedPassDays(purchase.id);
      expect(stillPending).toMatchObject({
        id: first.id,
        reservationState: "creating_hold",
        dotyposReservationId: null,
        passDayHoldGeneration: pending!.passDayHoldGeneration,
      });

      hidden = undefined;
      yield* releaseUnlimitedPassDays(replacement).pipe(
        Effect.provideService(DotyposService, {
          ...replacementService,
          cancelReservation: (id) =>
            provider.service.cancelReservation(id).pipe(
              Effect.andThen(
                Effect.fail(
                  new DotyposUncertain({
                    operation: "cancelReservation",
                    reason: "timeout",
                  })
                )
              )
            ),
        })
      );
      expect((yield* readUnlimitedPassDays(purchase.id))[0]).toMatchObject({
        id: first.id,
        reservationState: "cancelling",
        dotyposReservationId: replacementId,
      });
      hidden = replacementId;
      yield* releaseUnlimitedPassDays(replacement).pipe(
        Effect.provideService(DotyposService, replacementService)
      );
      const [released] = yield* readUnlimitedPassDays(purchase.id);
      expect(released).toMatchObject({
        id: first.id,
        reservationState: "cancelled",
        dotyposReservationId: replacementId,
      });
      expect(provider.reservations.get(replacementId)?.status).toBe(
        "CANCELLED"
      );
    }).pipe(Effect.provide(Layer.mergeAll(database!.layer, provider.layer)))
  );
});

for (const firstObservation of [
  "release",
  "expired create",
  "live capacity",
  "missing assignment table",
  "parallel lookup failure",
  "repeated provider ID",
] as const) {
  it(`settles ownership evidence from ${firstObservation}`, async () => {
    const provider = makeInMemoryDotypos({});
    const start = getCurrentWorkspaceDate().add({ days: 340 });
    let original: DotyposReservationId | undefined;
    let copy: DotyposReservationId | undefined;
    let omitOriginal = false;
    const service: DotyposService["Service"] = {
      ...provider.service,
      createReservation: (input) =>
        Effect.gen(function* () {
          const created = yield* provider.service.createReservation(input);
          if (!input.note?.includes(`/${start}/`)) return created;
          original = created.id;
          if (firstObservation !== "repeated provider ID") {
            copy = (yield* provider.service.createReservation(input)).id;
          }
          return yield* new DotyposUncertain({
            operation: "createReservation",
            reason: "timeout",
          });
        }),
      listReservations: (input) =>
        provider.service.listReservations(input).pipe(
          Effect.map((records) => {
            if (omitOriginal)
              return records.filter(({ id }) => id !== original);
            const first = records.find(({ id }) => id === original);
            return firstObservation === "repeated provider ID" && first
              ? [...records, first]
              : records;
          })
        ),
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const purchase = yield* record(start);
        const timedOut = yield* Effect.result(
          createUnlimitedPassHolds(purchase)
        );
        expect(timedOut).toEqual(
          Result.fail(expect.objectContaining({ _tag: "DotyposUncertain" }))
        );
        if (firstObservation === "repeated provider ID") {
          yield* releaseUnlimitedPassDays(purchase);
          expect((yield* readUnlimitedPassDays(purchase.id))[0]).toMatchObject({
            reservationState: "cancelled",
            dotyposReservationId: original,
            failureCode: null,
          });
          return;
        }
        if (firstObservation === "parallel lookup failure") {
          const repository = yield* WorkspaceReservationRepository;
          const recording = yield* Deferred.make<void>();
          const tableFailed = yield* Deferred.make<void>();
          const finishRecording = yield* Deferred.make<void>();
          const tableError = new DotyposUnavailable({
            operation: "getTables",
            reason: "server",
          });
          const assignment = Effect.flatMap(
            WorkspaceTableAssignmentService,
            (service) =>
              service.getAssignedTableAvailability({
                reservation: provider.reservations.get(original!)!,
                kind: "cowork",
              })
          ).pipe(
            Effect.provide(WorkspaceTableAssignmentService.Default),
            Effect.provideService(DotyposService, {
              ...service,
              getTables: () =>
                Deferred.await(recording).pipe(
                  Effect.andThen(Effect.fail(tableError)),
                  Effect.ensuring(
                    Deferred.succeed(tableFailed, undefined).pipe(Effect.asVoid)
                  )
                ),
            }),
            Effect.provideService(WorkspaceReservationRepository, {
              ...repository,
              recordAmbiguousPassDayHolds: (claims) =>
                Deferred.succeed(recording, undefined).pipe(
                  Effect.andThen(Deferred.await(finishRecording)),
                  Effect.andThen(repository.recordAmbiguousPassDayHolds(claims))
                ),
            })
          );
          const fiber = yield* Effect.forkChild(Effect.result(assignment));
          yield* Deferred.await(tableFailed);
          yield* Effect.yieldNow;
          yield* Deferred.succeed(finishRecording, undefined);
          expect(yield* Fiber.join(fiber)).toEqual(Result.fail(tableError));
        } else if (firstObservation === "missing assignment table") {
          const unavailable = yield* Effect.flatMap(
            WorkspaceTableAssignmentService,
            (assignment) =>
              assignment.getAssignedTableAvailability({
                reservation: provider.reservations.get(original!)!,
                kind: "cowork",
              })
          ).pipe(Effect.provide(WorkspaceTableAssignmentService.Default));
          expect(unavailable).toBe("unavailable");
        } else if (firstObservation === "live capacity") {
          yield* getBookableUnlimitedStarts({
            startsOn: start,
            endsBefore: start.add({ days: 1 }),
            selection: { tier: "reserved-desk" },
          });
        } else if (firstObservation === "expired create") {
          const { db } = yield* WorkspaceDatabase;
          yield* db
            .update(workspaceReservations)
            .set({
              reservationHoldExpiresAt: Temporal.Now.instant().subtract({
                minutes: 1,
              }),
            })
            .where(eq(workspaceReservations.passId, purchase.id));
          const expired = yield* Effect.result(
            createUnlimitedPassHolds(purchase)
          );
          expect(expired).toEqual(
            Result.fail(expect.objectContaining({ reason: "expired" }))
          );
        } else {
          yield* releaseUnlimitedPassDays(purchase);
        }
        const [ambiguous] = yield* readUnlimitedPassDays(purchase.id);
        expect(ambiguous).toMatchObject({
          reservationState: "creating_hold",
          dotyposReservationId: null,
          failureCode: ambiguousPassDayHoldCode,
        });
        const genuine = original!;
        const copied = copy!;
        omitOriginal = true;
        yield* releaseUnlimitedPassDays(purchase);
        const retry = yield* Effect.result(createUnlimitedPassHolds(purchase));
        expect(retry).toEqual(
          Result.fail(expect.objectContaining({ reason: "unfinished" }))
        );
        expect((yield* readUnlimitedPassDays(purchase.id))[0]).toEqual(
          ambiguous
        );
        expect(provider.reservations.get(genuine)?.status).toBe("NEW");
        expect(provider.reservations.get(copied)?.status).toBe("NEW");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            database!.layer,
            WorkspaceReservationRepository.Default.pipe(
              Layer.provide(database!.layer)
            ),
            Layer.mock(GoogleCalendarWorkspaceLimitationsService, {
              listLimitations: () => Effect.succeed([]),
            })
          )
        ),
        Effect.provideService(DotyposService, service)
      )
    );
  });
}

it("preserves an uncertain Continue and returns the affected date for a voided draft", async () => {
  const start = getCurrentWorkspaceDate().add({ days: 100 });
  const rejectedDate = date(start.add({ days: 2 }));
  const accountId = newAccountId();
  const email = testEmailAddress("unlimited-draft-retry");
  const session = {
    ...testSessionProfile,
    accountId,
    email,
    deletionRequested: false,
  };
  const provider = makeInMemoryDotypos({});
  const layer = Layer.mergeAll(
    database!.layer,
    Layer.mock(CurrentCustomerAccount, {
      requireActive: Effect.succeed(session),
    }),
    Layer.mock(CustomerAccountSections, {
      withActiveAccount: (_accountId, operation) =>
        Effect.provideService(operation, HeldCustomerAccount, {
          accountId,
          email,
        }),
    }),
    Layer.mock(CustomerAccountContactService, {}),
    Layer.mock(DiscountService, {}),
    Layer.mock(WorkspaceFeatureFlagService, {
      isEnabled: () => Effect.succeed(true),
    }),
    Layer.mock(WorkspaceDatabaseAdvisoryLock, {}),
    Layer.mock(WorkspaceReservationRepository, {}),
    Layer.mock(GoogleCalendarWorkspaceLimitationsService, {}),
    Layer.succeed(DotyposService, {
      ...provider.service,
      createReservation: (input) => {
        if (input.note?.includes(`/${date(start)}/`)) {
          return provider.service.createReservation(input).pipe(
            Effect.andThen(
              Effect.fail(
                new DotyposUncertain({
                  operation: "createReservation",
                  reason: "timeout",
                })
              )
            )
          );
        }
        if (input.note?.includes(`/${rejectedDate}/`)) {
          return Effect.fail(
            new DotyposRejected({
              operation: "createReservation",
              reason: "invalid-request",
            })
          );
        }
        return provider.service.createReservation(input);
      },
    })
  );

  await Effect.runPromise(
    Effect.gen(function* () {
      const purchase = yield* record(start, accountId, accountId);
      const begin = beginUnlimitedPassPurchase({
        orderId: purchase.id,
        locale: "en-US",
        selection: { tier: "reserved-desk", startDate: date(start) },
      });
      expect(yield* Effect.result(begin)).toEqual(
        Result.fail(expect.objectContaining({ _tag: "DotyposUncertain" }))
      );
      const { db } = yield* WorkspaceDatabase;
      const status = db
        .select({ status: passPurchases.status })
        .from(passPurchases)
        .where(eq(passPurchases.id, purchase.id));
      expect(yield* status).toEqual([{ status: "pending_payment" }]);

      const expected = Result.fail(
        expect.objectContaining({
          _tag: "UnlimitedPassDraftVoided",
          blockingDates: [rejectedDate],
        })
      );
      expect(yield* Effect.result(begin)).toEqual(expected);
      expect(yield* status).toEqual([{ status: "void" }]);
      expect(yield* Effect.result(begin)).toEqual(expected);
    }).pipe(Effect.provide(layer))
  );
});

it("rejects a Continue replay when an attached day's deadline passed", async () => {
  const provider = makeInMemoryDotypos({});
  await Effect.runPromise(
    Effect.gen(function* () {
      const start = getCurrentWorkspaceDate().add({ days: 4000 });
      const purchase = yield* record(start);
      yield* createUnlimitedPassHolds(purchase);
      const [first] = yield* readUnlimitedPassDays(purchase.id);
      const { db } = yield* WorkspaceDatabase;
      yield* db
        .update(workspaceReservations)
        .set({
          reservationHoldExpiresAt: Temporal.Now.instant().subtract({
            seconds: 1,
          }),
        })
        .where(eq(workspaceReservations.id, first!.id));
      const replay = yield* Effect.result(createUnlimitedPassHolds(purchase));
      expect(replay).toEqual(
        Result.fail(
          expect.objectContaining({
            reason: "expired",
            blockingDates: [first!.serviceDate],
          })
        )
      );
      expect(provider.reservations.size).toBe(unlimitedPassDays);
    }).pipe(
      Effect.provide(database!.layer),
      Effect.provideService(DotyposService, provider.service)
    )
  );
});

it("adopts an ambiguous POST, reconfirms all days, then retains today on release", async () => {
  const provider = makeInMemoryDotypos({});
  let interruptOnce = true;
  const createReservation: typeof provider.service.createReservation = (
    input
  ) =>
    provider.service.createReservation(input).pipe(
      Effect.flatMap((created) => {
        if (!interruptOnce) return Effect.succeed(created);
        interruptOnce = false;
        return Effect.fail(
          new DotyposUncertain({
            operation: "createReservation",
            reason: "timeout",
          })
        );
      })
    );

  await Effect.runPromise(
    Effect.gen(function* () {
      const start = getCurrentWorkspaceDate().add({ days: 1 });
      const purchase = yield* record(start);
      const initial = yield* readUnlimitedPassDays(purchase.id);
      const attempt = yield* Effect.result(createUnlimitedPassHolds(purchase));
      expect(Result.isFailure(attempt)).toBe(true);
      expect(provider.reservations.size).toBeGreaterThan(0);
      const incomplete = yield* Effect.result(
        reconfirmUnlimitedPassHolds(purchase)
      );
      expect(Result.isFailure(incomplete)).toBe(true);

      yield* createUnlimitedPassHolds(purchase);
      yield* reconfirmUnlimitedPassHolds(purchase);
      const missing = yield* Effect.result(
        reconfirmUnlimitedPassHolds(purchase).pipe(
          Effect.provideService(DotyposService, {
            ...provider.service,
            getReservationsByIds: () => Effect.succeed(new Map()),
          })
        )
      );
      expect(missing).toEqual(
        Result.fail(expect.objectContaining({ reason: "unfinished" }))
      );
      expect(provider.reservations.size).toBe(unlimitedPassDays);
      expect(
        (yield* readUnlimitedPassDays(purchase.id)).map(({ id }) => id)
      ).toEqual(initial.map(({ id }) => id));

      const now = Temporal.Now.instant();
      const { db } = yield* WorkspaceDatabase;
      const attemptId = paymentAttemptIdSchema.make(crypto.randomUUID());
      yield* db.insert(paymentAttempts).values({
        id: attemptId,
        orderId: purchase.id,
        provider: "mock",
        providerOrderId: "fixture-ambiguous-holds-payment",
        state: "paid",
        amountValue: 599_000,
        amountExponent: 2,
        currency: "CZK",
      });
      yield* db
        .update(orders)
        .set({
          paymentState: "paid",
          activePaymentAttemptId: attemptId,
          paidAt: now,
          updatedAt: now,
        })
        .where(eq(orders.id, purchase.id));
      expect(yield* settlePassPurchase(purchase.id)).toBeUndefined();
      yield* confirmUnlimitedPassDays(purchase);
      yield* confirmUnlimitedPassDays(purchase);
      expect((yield* settlePassPurchase(purchase.id, attemptId))?.status).toBe(
        "active"
      );
      expect(
        [...provider.reservations.values()].every(
          (row) => row.status === "CONFIRMED"
        )
      ).toBe(true);

      yield* releaseUnlimitedPassDays({
        ...purchase,
        status: "withdrawn",
        accessEndsOn: date(start.add({ days: 1 })),
      });
      const days = yield* readUnlimitedPassDays(purchase.id);
      expect(days[0]?.reservationState).toBe("confirmed");
      expect(
        days.slice(1).every((row) => row.reservationState === "cancelled")
      ).toBe(true);
    }).pipe(
      Effect.provide(database!.layer),
      Effect.provideService(DotyposService, {
        ...provider.service,
        createReservation,
      })
    )
  );
});
