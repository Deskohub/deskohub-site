import {
  type BeginCustomerPassPurchase,
  type CustomerPassPurchase,
  CustomerSessionRequired,
  type SubmitCustomerPassPurchase,
  type UpdateCustomerPassPurchasePrice,
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

const writePass = <A, E, R>(
  write: (passes: Effect.Success<typeof passesApi>) => Effect.Effect<A, E, R>
) =>
  confirmPassPurchaseScope.pipe(
    Effect.andThen(passesApi.pipe(Effect.flatMap(write), customerWrite))
  );

export const beginPassPurchaseAtom = customerDataRuntime.fn(
  (payload: BeginCustomerPassPurchase) =>
    writePass((passes) => passes.beginPassPurchase({ payload }))
);

export const submitPassPurchaseAtom = customerDataRuntime.fn(
  ({
    orderId,
    payload,
  }: {
    orderId: string;
    payload: SubmitCustomerPassPurchase;
  }) =>
    writePass((passes) =>
      passes.submitPassPurchase({ params: { orderId }, payload })
    )
);

export const updatePassPurchasePriceAtom = customerDataRuntime.fn(
  ({
    orderId,
    payload,
  }: {
    orderId: string;
    payload: UpdateCustomerPassPurchasePrice;
  }) =>
    writePass((passes) =>
      passes.updatePassPurchasePrice({ params: { orderId }, payload })
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

export const passPaymentPayload = (
  quote: CustomerPassPurchase,
  billing: NonNullable<SubmitCustomerPassPurchase["billing"]>,
  returnTarget: NonNullable<SubmitCustomerPassPurchase["returnTarget"]>
): SubmitCustomerPassPurchase => ({
  productKind: quote.product.kind,
  accepted: true,
  acceptedDocuments: quote.disclosure.documents.map(({ key, hash }) => ({
    key,
    hash,
  })),
  ...(quote.product.kind === "unlimited" &&
    quote.disclosure.earlyStartRequest !== undefined && {
      unlimitedEarlyStartAccepted: true,
    }),
  displayedPriceFingerprint: quote.price.fingerprint,
  billing,
  returnTarget,
});
