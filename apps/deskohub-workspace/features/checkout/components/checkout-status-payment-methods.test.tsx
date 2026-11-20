import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import {
  workspaceRouterRefresh,
  workspaceUseAction,
} from "@/shared/testing/workspace-component-module-mocks";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";
import { CheckoutStatusPaymentMethods } from "./checkout-status-payment-methods";

beforeAll(registerWorkspaceComponentTestEnv);
afterAll(unregisterWorkspaceComponentTestEnv);
afterEach(cleanup);

test("switches from card to QR and reopens card on the same reservation", () => {
  const execute = mock();
  workspaceUseAction.mockReturnValue({ execute, isExecuting: false });
  const continuePaymentAction = mock(async () => ({}));
  const orderId =
    "658d5a17-1ccc-4d97-baab-6cbb015125ca" as WorkspaceReservationId;
  const checkout = { continuePaymentAction, locale: "en-US", orderId } as const;
  const view = render(<CheckoutStatusPaymentMethods {...checkout} />);

  expect(view.queryByRole("img")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Show QR payment" }));
  expect(execute).toHaveBeenLastCalledWith({
    locale: "en-US",
    method: "qr",
    orderId,
  });

  const actionOptions = workspaceUseAction.mock.calls.at(-1)?.[1] as
    | {
        readonly onSuccess: (result: {
          readonly data:
            | { readonly status: "qr_pending" }
            | { readonly status: "redirect"; readonly redirectUrl: string };
        }) => void;
      }
    | undefined;
  if (!actionOptions) throw new Error("Checkout action options missing");
  act(() => actionOptions.onSuccess({ data: { status: "qr_pending" } }));
  expect(workspaceRouterRefresh).toHaveBeenCalled();

  view.rerender(
    <CheckoutStatusPaymentMethods
      {...checkout}
      qrPayment={{
        accountNumber: "19-2000145399/0800",
        amount: "CZK 450.50",
        deadline: "Nov 19, 2026, 3:30 PM",
        expiresAt: "2026-11-19T14:30:00Z",
        qrCodeSource: "data:image/png;base64,iVBORw0KGgo=",
        variableSymbol: "0012345678",
      }}
    />
  );
  expect(view.getByRole("img", { name: "Bank transfer QR code" })).toBeTruthy();
  expect(view.queryByRole("button", { name: "Show QR payment" })).toBeNull();
  fireEvent.click(
    view.getByRole("button", { name: "Continue to card payment" })
  );
  expect(execute).toHaveBeenLastCalledWith({
    locale: "en-US",
    method: "card",
    orderId,
  });
  const open = spyOn(window, "open").mockReturnValue({} as Window);
  const redirectUrl = "https://payments.example.test/same-hosted-session";
  act(() =>
    actionOptions.onSuccess({ data: { status: "redirect", redirectUrl } })
  );
  expect(open).toHaveBeenCalledWith(redirectUrl, "_blank");
  open.mockRestore();
});
