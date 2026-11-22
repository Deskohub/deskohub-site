import {
  type BeginCustomerPassPurchase,
  CustomerSessionRequired,
  type SubmitCustomerPassPurchase,
} from "@deskohub/workspace-customer-api";
import { Effect } from "effect";
import { Atom } from "effect/reactivity";
import { paymentBrowserLayer } from "../../booking/payment-browser";
import { PaymentBrowser } from "../../booking/payment-browser.service";
import { AccountExitFence } from "../../customer-api/account-scoped-storage";
import {
  CustomerAccountScope,
  CustomerApi,
  CustomerAuthApi,
} from "../../customer-api/customer-api.service";
import { customerDataRuntime } from "../../customer-api/customer-data-runtime";
import {
  customerRead,
  customerWrite,
} from "../../customer-api/customer-request";

const passesApi = Effect.map(Effect.service(CustomerApi), (api) => api.passes);

/** Recheck the signed-in cookie before sending gift or billing details. */
export const confirmPassPurchaseScope = Effect.Do.pipe(
  Effect.bind("scope", () => Effect.service(CustomerAccountScope)),
  Effect.bind("fence", () => Effect.service(AccountExitFence)),
  Effect.bind("auth", () => Effect.service(CustomerAuthApi)),
  Effect.bind("session", ({ auth }) => auth.auth.getSession({})),
  Effect.filterOrFail(
    ({ scope, session }) => session?.user.id === scope.accountId,
    () => new CustomerSessionRequired()
  ),
  Effect.flatMap(({ scope, fence }) => fence.isCurrent(scope)),
  Effect.filterOrFail(
    (current) => current,
    () => new CustomerSessionRequired()
  ),
  Effect.asVoid,
  customerRead({ accountRead: false })
);

export const passOffersAtom = customerDataRuntime.atom(
  passesApi.pipe(
    Effect.flatMap((api) => api.listPassOffers({})),
    customerRead({ accountRead: false })
  )
);

export const unlimitedStartDatesAtom = Atom.family(
  (supersedeOrderId: string | undefined | false) =>
    customerDataRuntime.atom(
      supersedeOrderId === false
        ? Effect.succeed(undefined)
        : passesApi.pipe(
            Effect.flatMap((api) =>
              api.getUnlimitedStartDates({
                query:
                  supersedeOrderId === undefined ? {} : { supersedeOrderId },
              })
            ),
            customerRead({ accountRead: false })
          )
    )
);

export const beginPassPurchaseAtom = customerDataRuntime.fn(
  (payload: BeginCustomerPassPurchase) =>
    confirmPassPurchaseScope.pipe(
      Effect.andThen(
        passesApi.pipe(
          Effect.flatMap((api) => api.beginPassPurchase({ payload })),
          customerWrite
        )
      )
    )
);

export const submitPassPurchaseAtom = customerDataRuntime.fn(
  ({
    orderId,
    payload,
  }: {
    orderId: string;
    payload: SubmitCustomerPassPurchase;
  }) =>
    confirmPassPurchaseScope.pipe(
      Effect.andThen(
        passesApi.pipe(
          Effect.flatMap((api) =>
            api.submitPassPurchase({ params: { orderId }, payload })
          ),
          customerWrite
        )
      )
    )
);

export const openPassPaymentAtom = customerDataRuntime.fn(
  ({ orderId, redirectUrl }: { orderId: string; redirectUrl: string }) =>
    confirmPassPurchaseScope.pipe(
      Effect.andThen(Effect.service(PaymentBrowser)),
      Effect.flatMap((browser) =>
        browser.open(redirectUrl, passPaymentReturnUrl(orderId))
      ),
      Effect.provide(paymentBrowserLayer)
    )
);

export const passPaymentReturnUrl = (orderId: string) =>
  `deskohub://passes/purchases/${encodeURIComponent(orderId)}?after=payment`;

export const passPurchaseStatusHref = (orderId: string) =>
  ({
    pathname: "/passes/purchases/[orderId]",
    params: { orderId, after: "payment" },
  }) as const;
