import type {
  BeginCustomerPassPurchase,
  SubmitCustomerPassPurchase,
} from "@deskohub/workspace-customer-api";
import { Effect } from "effect";
import { Atom } from "effect/reactivity";
import { paymentBrowserLayer } from "../../booking/payment-browser";
import { PaymentBrowser } from "../../booking/payment-browser.service";
import { CustomerApi } from "../../customer-api/customer-api.service";
import { customerDataRuntime } from "../../customer-api/customer-data-runtime";
import {
  customerRead,
  customerWrite,
} from "../../customer-api/customer-request";

const passesApi = Effect.map(Effect.service(CustomerApi), (api) => api.passes);

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
    passesApi.pipe(
      Effect.flatMap((api) => api.beginPassPurchase({ payload })),
      customerWrite
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
    passesApi.pipe(
      Effect.flatMap((api) =>
        api.submitPassPurchase({ params: { orderId }, payload })
      ),
      customerWrite
    )
);

export const openPassPaymentAtom = customerDataRuntime.fn(
  ({ orderId, redirectUrl }: { orderId: string; redirectUrl: string }) =>
    Effect.service(PaymentBrowser).pipe(
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
