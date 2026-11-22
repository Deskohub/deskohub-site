import {
  type CustomerLocale,
  type CustomerPassPurchaseStatus,
  CustomerSessionRequired,
} from "@deskohub/workspace-customer-api";
import {
  type Cause,
  Duration,
  Effect,
  Option,
  Queue,
  Result,
  Stream,
} from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  AccountReadBudget,
  allowsAutomaticRefresh,
} from "../../../customer-api/account-read-budget";
import { AccountExitFence } from "../../../customer-api/account-scoped-storage";
import {
  CustomerAccountScope,
  CustomerApi,
} from "../../../customer-api/customer-api.service";
import { customerDataRuntime } from "../../../customer-api/customer-data-runtime";
import { customerRead } from "../../../customer-api/customer-request";
import { appForegroundAtom } from "../../../platform/app-foreground";

/** Read only in the account session that owns the screen, including on return. */
export const readPassPurchaseStatus = Effect.fn("readPassPurchaseStatus")(
  function* (orderId: string, locale: CustomerLocale) {
    const scope = yield* CustomerAccountScope;
    const fence = yield* AccountExitFence;
    const api = yield* CustomerApi;
    if (!(yield* fence.isCurrent(scope))) {
      return yield* new CustomerSessionRequired();
    }
    const status = yield* api.passes
      .getPassPurchaseStatus({ params: { orderId }, query: { locale } })
      .pipe(customerRead({ accountRead: true }));
    if (!(yield* fence.isCurrent(scope))) {
      return yield* new CustomerSessionRequired();
    }
    return status;
  }
);

// Space out settlement reads and keep the account budget available for taps.
const pollDelays = [3, 3, 5, 5, 10, 15, 20, 30, 60] as const;

type StatusRead = Result.Result<
  CustomerPassPurchaseStatus,
  Effect.Error<ReturnType<typeof readPassPurchaseStatus>>
>;

interface StatusProgress {
  readonly refresh: number;
  readonly attempts: number;
  readonly reading: "manual" | "automatic" | false;
  readonly polling: boolean;
  readonly outcome?: StatusRead;
}

interface StatusRefresh {
  readonly revision: number;
  readonly afterPayment: boolean;
}

const statusUpdates = (
  read: ReturnType<typeof readPassPurchaseStatus>,
  refresh: number,
  start: StatusProgress
) =>
  Stream.callback((queue: Queue.Queue<StatusProgress, Cause.Done>) =>
    Effect.gen(function* () {
      const budget = yield* AccountReadBudget;
      let state = start;
      const readOnce = (reading: "manual" | "automatic") =>
        Effect.gen(function* () {
          state = {
            ...state,
            refresh,
            reading,
            attempts: state.attempts + (reading === "automatic" ? 1 : 0),
          };
          yield* Queue.offer(queue, state);
          const outcome = yield* Effect.result(read);
          state = {
            ...state,
            outcome,
            reading: false,
            polling:
              state.polling &&
              Result.isSuccess(outcome) &&
              (outcome.success.status === "pending" ||
                outcome.success.status === "checking"),
          };
          yield* Queue.offer(queue, state);
        });

      if (
        !state.outcome ||
        state.refresh !== refresh ||
        state.reading === "manual"
      ) {
        yield* readOnce("manual");
      } else {
        // A backgrounded automatic request already spent its attempt.
        state = { ...state, reading: false };
        yield* Queue.offer(queue, state);
      }

      for (const seconds of pollDelays.slice(state.attempts)) {
        if (!state.polling || !allowsAutomaticRefresh(yield* budget.remaining))
          break;
        yield* Effect.sleep(Duration.seconds(seconds));
        if (!allowsAutomaticRefresh(yield* budget.remaining)) break;
        yield* readOnce("automatic");
      }

      yield* Queue.offer(queue, { ...state, polling: false });
    })
  );

/**
 * Each mounted visit has its own refresh count. Going offscreen interrupts
 * its timer or request, preserving the count and answer for when it resumes.
 */
export const makePassPurchaseStatusAtoms = (
  orderId: string,
  locale: CustomerLocale,
  afterPayment: boolean,
  foreground = appForegroundAtom
) => {
  const focused = Atom.make(false);
  const refresh = Atom.make<StatusRefresh>({ revision: 0, afterPayment });
  const status = customerDataRuntime.atom((get) => {
    const active = get(focused) && get(foreground);
    const request = get(refresh);
    if (!active) return Stream.never;

    const previous = Option.flatMap(
      get.self<AsyncResult.AsyncResult<StatusProgress, never>>(),
      AsyncResult.value
    );
    let start = Option.getOrElse(
      previous,
      (): StatusProgress => ({
        refresh: request.revision,
        attempts: 0,
        reading: false,
        polling: request.afterPayment,
      })
    );
    if (request.afterPayment && start.refresh !== request.revision) {
      start = { ...start, attempts: 0, polling: true };
    }
    return statusUpdates(
      readPassPurchaseStatus(orderId, locale),
      request.revision,
      start
    );
  });

  return { focused, refresh, status };
};
