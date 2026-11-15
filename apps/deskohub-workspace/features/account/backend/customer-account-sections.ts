import { Context, Data, Effect, Layer, Option } from "effect";
import type { SqlError } from "effect/unstable/sql";
import { WorkspaceDatabaseAdvisoryLock } from "@/db/postgres-advisory-lock";
import {
  holdSections,
  WorkspaceLockSectionSpecs,
  WorkspaceLockSections,
} from "@/db/workspace-locks";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import {
  CustomerAccountAccessError,
  type CustomerAccountId,
  customerAccountUnavailable,
  mapCustomerAccountFailure,
} from "../customer-account";
import { CustomerAccountLinkRepository } from "./customer-account-link.repository";
import { CustomerAuthentication } from "./customer-authentication.service";

/**
 * The account whose lock the enclosing section holds and whose state it
 * rechecked under that lock. `email` is the account's immutable login email,
 * read under the lock. Only a section provides it, so a step that declares it
 * in its requirements can only run held.
 */
export class HeldCustomerAccount extends Context.Service<
  HeldCustomerAccount,
  {
    readonly accountId: CustomerAccountId;
    readonly email: string;
  }
>()("@deskohub-workspace/account/HeldCustomerAccount") {}

/**
 * What a section rechecks under the lock before its work runs:
 *
 * - `session`: the session re-read under the lock is this account's, and the
 *   account exists with no deletion marker.
 * - `active`: the account exists with no deletion marker. No session read,
 *   for callers that read the session just before the lock or act for a
 *   given account.
 * - `present`: the account exists; a deletion marker is tolerated. Only
 *   deletion uses it, because it writes that marker and must stay retryable.
 */
type CustomerAccountRecheck = "session" | "active" | "present";

type CustomerAccountSectionOptions = {
  /** Defaults to `session`. */
  readonly recheck?: CustomerAccountRecheck;
};

/**
 * Work for the signed-in account, or for an anonymous visitor when the
 * account is null, so the state it creates can name its author.
 */
type OptionalAccountSection<A, E, R> = (
  accountId: CustomerAccountId | null
) => Effect.Effect<A, E, R>;

type OptionalAccountSectionOptions = {
  /**
   * Also holds this order's section while the work runs. With a signed-in
   * session both sections are held in one combined entry, the account's
   * before the order's, on one connection under one pool permit; otherwise
   * the order's section is held alone. A call inside an enclosing account
   * section dies before any lock is requested, since the order's section
   * would nest and take a second permit.
   */
  readonly reservationOrder: WorkspaceReservationId;
};

interface ICustomerAccountSections {
  /**
   * Runs `section` holding the account lock on its own connection, after the
   * recheck, with `HeldCustomerAccount` provided. Enter it outside every
   * Workspace transaction; the section's writers open their own.
   *
   * Inside a section that already holds this account, it runs `section`
   * under that hold: no second lock and no second recheck, because the
   * enclosing section's recheck stands for the whole hold.
   *
   * Recheck failures: no matching session or no account fails
   * `unauthenticated`, a deletion marker fails `link-required` with
   * `deletion-requested`, and an unreadable account fails `unavailable`
   * (`account.deletion-state`). The lock's own failure is `unavailable`
   * (`account-link.lock`). The section's failures pass through unchanged.
   */
  readonly withActiveAccount: <A, E, R>(
    accountId: CustomerAccountId,
    section: Effect.Effect<A, E, R>,
    options?: CustomerAccountSectionOptions
  ) => Effect.Effect<
    A,
    E | CustomerAccountAccessError,
    Exclude<R, HeldCustomerAccount>
  >;
  /**
   * Runs `section` for the current session's account inside
   * `withActiveAccount` with the `active` recheck. An anonymous session, or
   * authentication that isn't configured (Better Auth secrets are optional
   * outside production), runs it without a lock and with a null account.
   * Any other session failure fails closed before the section runs.
   */
  readonly withOptionalAccount: {
    <A, E, R>(
      section: OptionalAccountSection<A, E, R>
    ): Effect.Effect<A, E | CustomerAccountAccessError, R>;
    /**
     * Holds the order's section too (`OptionalAccountSectionOptions`). The
     * combined entry's own failure maps like the account lock's; the order
     * section's own failure, held alone, is its `SqlError`.
     */
    <A, E, R>(
      section: OptionalAccountSection<A, E, R>,
      options: OptionalAccountSectionOptions
    ): Effect.Effect<A, E | CustomerAccountAccessError | SqlError.SqlError, R>;
  };
}

export class CustomerAccountSections extends Context.Service<
  CustomerAccountSections,
  ICustomerAccountSections
>()("@deskohub-workspace/account/CustomerAccountSections") {
  static Default = Layer.effect(
    this,
    Effect.gen(function* () {
      const authentication = yield* CustomerAuthentication;
      const links = yield* CustomerAccountLinkRepository;
      const advisoryLock = yield* WorkspaceDatabaseAdvisoryLock;

      const recheck = (
        accountId: CustomerAccountId,
        recheck: CustomerAccountRecheck
      ): Effect.Effect<
        HeldCustomerAccount["Service"],
        CustomerAccountAccessError
      > =>
        Effect.gen(function* () {
          if (recheck === "session") {
            const session = yield* authentication.currentUser;
            if (session?.accountId !== accountId) {
              return yield* new CustomerAccountAccessError({
                reason: "unauthenticated",
              });
            }
          }
          const activity = yield* links
            .findActivityState(accountId)
            .pipe(
              Effect.mapError(
                mapCustomerAccountFailure("account.deletion-state")
              )
            );
          if (activity.kind === "missing") {
            return yield* new CustomerAccountAccessError({
              reason: "unauthenticated",
            });
          }
          if (recheck !== "present" && activity.deletionRequestedAt != null) {
            return yield* new CustomerAccountAccessError({
              reason: "link-required",
              linkReason: "deletion-requested",
            });
          }
          return { accountId, email: activity.email };
        });

      /** This account's hold by an enclosing section, if there is one. */
      const enclosingHold = (accountId: CustomerAccountId) =>
        Effect.map(
          Effect.serviceOption(HeldCustomerAccount),
          Option.filter((held) => held.accountId === accountId)
        );

      /** Runs `section` after the recheck, with the rechecked account held. */
      const afterRecheck = <A, E, R>(
        accountId: CustomerAccountId,
        recheckKind: CustomerAccountRecheck,
        section: Effect.Effect<A, E, R>
      ) =>
        recheck(accountId, recheckKind).pipe(
          Effect.flatMap((held) =>
            Effect.provideService(section, HeldCustomerAccount, held)
          )
        );

      const withActiveAccount: ICustomerAccountSections["withActiveAccount"] = (
        accountId,
        section,
        options
      ) =>
        Effect.flatMap(
          enclosingHold(accountId),
          Option.match({
            onSome: (held) =>
              Effect.provideService(section, HeldCustomerAccount, held),
            onNone: () =>
              holdAccount(
                accountId,
                afterRecheck(accountId, options?.recheck ?? "session", section)
              ),
          })
        );

      /**
       * The lock's own SqlError is the only failure the registry adds. The
       * work's failures cross the lock wrapped, so a SqlError of the work is
       * never taken for the lock's. With an order, the account's and the
       * order's sections are one combined entry, whose failure is the lock's.
       */
      const holdAccount = <A, E, R>(
        accountId: CustomerAccountId,
        work: Effect.Effect<A, E, R>,
        reservationOrder?: WorkspaceReservationId
      ): Effect.Effect<A, E | CustomerAccountAccessError, R> =>
        (reservationOrder === undefined
          ? WorkspaceLockSections.customerAccount(accountId)
          : holdSections([
              WorkspaceLockSectionSpecs.customerAccount(accountId),
              WorkspaceLockSectionSpecs.reservationOrder(reservationOrder),
            ]))(
          work.pipe(Effect.mapError((error) => new SectionFailure({ error })))
        ).pipe(
          Effect.provideService(WorkspaceDatabaseAdvisoryLock, advisoryLock),
          Effect.catchTag("SqlError", () =>
            Effect.fail(customerAccountUnavailable("account-link.lock"))
          ),
          Effect.catchTag("CustomerAccountSectionFailure", (failure) =>
            Effect.fail(failure.error)
          )
        );

      /** The order's section held alone; its own failure is its SqlError. */
      const holdOrder = <A, E, R>(
        reservationOrder: WorkspaceReservationId,
        work: Effect.Effect<A, E, R>
      ) =>
        WorkspaceLockSections.reservationOrder(reservationOrder)(work).pipe(
          Effect.provideService(WorkspaceDatabaseAdvisoryLock, advisoryLock)
        );

      /**
       * Dies before the session read and before any lock is requested
       * inside an enclosing account section: the order's section would
       * nest under that hold, signed in or not, and wait for a second pool
       * permit while holding one.
       */
      const outsideAccountSections = Effect.flatMap(
        Effect.serviceOption(HeldCustomerAccount),
        (enclosing) =>
          Option.isSome(enclosing)
            ? Effect.die(
                new Error(
                  "A reservationOrder section was requested inside an enclosing customerAccount section; hold both in one entry instead of nesting them"
                )
              )
            : Effect.void
      );

      function withOptionalAccount<A, E, R>(
        section: OptionalAccountSection<A, E, R>
      ): Effect.Effect<A, E | CustomerAccountAccessError, R>;
      function withOptionalAccount<A, E, R>(
        section: OptionalAccountSection<A, E, R>,
        options: OptionalAccountSectionOptions
      ): Effect.Effect<
        A,
        E | CustomerAccountAccessError | SqlError.SqlError,
        R
      >;
      function withOptionalAccount<A, E, R>(
        section: OptionalAccountSection<A, E, R>,
        options?: OptionalAccountSectionOptions
      ) {
        const reservationOrder = options?.reservationOrder;
        const sessionRead =
          reservationOrder === undefined
            ? authentication.currentUser
            : Effect.andThen(
                outsideAccountSections,
                authentication.currentUser
              );
        return sessionRead.pipe(
          Effect.catchIf(isAuthenticationNotConfigured, () =>
            Effect.succeed(null)
          ),
          Effect.flatMap(
            (
              session
            ): Effect.Effect<
              A,
              E | CustomerAccountAccessError | SqlError.SqlError,
              R
            > => {
              if (session === null) {
                return reservationOrder === undefined
                  ? section(null)
                  : holdOrder(reservationOrder, section(null));
              }
              return reservationOrder === undefined
                ? withActiveAccount(
                    session.accountId,
                    section(session.accountId),
                    { recheck: "active" }
                  )
                : holdAccount(
                    session.accountId,
                    afterRecheck(
                      session.accountId,
                      "active",
                      section(session.accountId)
                    ),
                    reservationOrder
                  );
            }
          )
        );
      }

      return {
        withActiveAccount,
        withOptionalAccount,
      } satisfies ICustomerAccountSections;
    })
  );

  /**
   * The sections reading the session through the `CustomerAuthentication`
   * the caller provides later, such as a customer API request's.
   */
  static ForProvidedAuthentication = this.Default.pipe(
    Layer.provide(
      Layer.mergeAll(
        CustomerAccountLinkRepository.Live,
        WorkspaceDatabaseAdvisoryLock.Default
      )
    )
  );

  /**
   * The sections reading the session through this authentication, such as
   * an agent's access token instead of the browser session.
   */
  static withAuthentication = <E, R>(
    authentication: Layer.Layer<CustomerAuthentication, E, R>
  ) => this.ForProvidedAuthentication.pipe(Layer.provide(authentication));

  static Live = this.withAuthentication(CustomerAuthentication.Default);
}

class SectionFailure<E> extends Data.TaggedError(
  "CustomerAccountSectionFailure"
)<{
  readonly error: E;
}> {}

const isAuthenticationNotConfigured = (error: CustomerAccountAccessError) =>
  error.reason === "not-configured";
