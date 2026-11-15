import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import {
  workspaceRouterPush,
  workspaceRouterRefresh,
  workspaceUseAction,
} from "@/shared/testing/workspace-component-module-mocks";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";

mock.module("@/features/checkout/actions/prepare-payment-retry", () => ({
  preparePaymentRetry: mock(),
}));

const { CheckoutStatusPaymentRetry } = await import(
  "./checkout-status-payment-retry"
);

type ActionOptions = {
  readonly onSuccess: (result: { readonly data?: unknown }) => void;
  readonly onError: (result: {
    readonly error: { readonly serverError?: string };
  }) => void;
  readonly onTransportError: () => void;
};

const orderId = "reservation-payment-retry" as WorkspaceReservationId;
const payUrl = "/en-US/checkout/pay?state=sealed-retry";

const renderRetry = ({ isExecuting = false } = {}) => {
  const execute = mock(
    (_input: { readonly locale: string; readonly orderId: string }) => undefined
  );
  workspaceUseAction.mockReturnValue({ execute, isExecuting } as never);
  const view = render(
    <CheckoutStatusPaymentRetry
      className="actions"
      fallback={
        <a href="/en-US/cowork" id="checkout-status-reserve-again">
          book
        </a>
      }
      locale="en-US"
      orderId={orderId}
    >
      <a href="/en-US" id="home">
        home
      </a>
    </CheckoutStatusPaymentRetry>
  );
  const options = workspaceUseAction.mock.calls.at(-1)?.[1] as
    | ActionOptions
    | undefined;
  if (!options) throw new Error("Payment retry action options missing");
  const button = () =>
    view.container.querySelector("#checkout-status-try-payment-again");
  const clickButton = () => {
    const element = button();
    if (!(element instanceof HTMLButtonElement)) {
      throw new Error("Try payment again button missing");
    }
    fireEvent.click(element);
    return element;
  };
  const fallback = () =>
    view.container.querySelector("#checkout-status-reserve-again");
  const spotNotice = () =>
    view.container.querySelector("#checkout-status-payment-retry-refusal");
  const answer = (data: unknown) =>
    act(() => {
      options.onSuccess({ data });
    });
  return {
    answer,
    button,
    clickButton,
    execute,
    fallback,
    options,
    spotNotice,
    view,
  };
};

describe("CheckoutStatusPaymentRetry", () => {
  beforeAll(() => {
    registerWorkspaceComponentTestEnv();
  });

  beforeEach(() => {
    workspaceRouterPush.mockClear();
    workspaceRouterRefresh.mockClear();
    workspaceUseAction.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  afterAll(async () => {
    await unregisterWorkspaceComponentTestEnv();
  });

  test("leads the action row with its button in place of booking again", () => {
    const { button, fallback, spotNotice, view } = renderRetry();

    const row = view.container.querySelector(".actions");
    expect(row?.firstElementChild).toBe(button());
    expect(row?.querySelector("#home")).not.toBeNull();
    expect(fallback()).toBeNull();
    expect(spotNotice()).toBeNull();
    expect(view.getByRole("alert").textContent).toBe("");
  });

  test("asks to pay the order again with only the order and locale", () => {
    const { clickButton, execute } = renderRetry();

    clickButton();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toEqual({ locale: "en-US", orderId });
  });

  test("is disabled while the request runs", () => {
    const { clickButton, execute } = renderRetry({ isExecuting: true });

    const element = clickButton();

    expect(element.disabled).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  test("opens the order's Pay page and stays pending while it loads", () => {
    const { answer, clickButton, execute } = renderRetry();

    answer({ state: "ready", payUrl });

    expect(workspaceRouterPush).toHaveBeenCalledWith(payUrl);
    expect(workspaceRouterRefresh).not.toHaveBeenCalled();
    const element = clickButton();
    expect(element.disabled).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  test("refreshes the status while the earlier payment may still settle", () => {
    const { answer, button, fallback } = renderRetry();

    answer({ state: "payment_settling" });

    expect(workspaceRouterRefresh).toHaveBeenCalledTimes(1);
    expect(workspaceRouterPush).not.toHaveBeenCalled();
    expect(button()).not.toBeNull();
    expect(fallback()).toBeNull();
  });

  test("offers booking again after a notice when the spot was taken", () => {
    const { answer, button, fallback, spotNotice, view } = renderRetry();

    answer({ state: "spot_unavailable" });

    expect(spotNotice()?.textContent).not.toBe("");
    expect(button()).toBeNull();
    const row = view.container.querySelector(".actions");
    expect(row?.firstElementChild).toBe(fallback());
    expect(workspaceRouterRefresh).toHaveBeenCalledTimes(1);
    expect(workspaceRouterPush).not.toHaveBeenCalled();
  });

  test("offers booking again without a notice when the order is refused", () => {
    const { answer, button, fallback, spotNotice } = renderRetry();

    answer({ state: "refused" });

    expect(fallback()).not.toBeNull();
    expect(button()).toBeNull();
    expect(spotNotice()).toBeNull();
    expect(workspaceRouterRefresh).toHaveBeenCalledTimes(1);
  });

  test("hands the refused button's focus to booking again", () => {
    const { answer, button, fallback } = renderRetry();
    (button() as HTMLButtonElement).focus();
    fireEvent.click(button() as HTMLButtonElement);

    answer({ state: "refused" });

    expect(document.activeElement).toBe(fallback());
  });

  test("leaves focus where the customer moved it before the refusal", () => {
    const { answer, button, view } = renderRetry();
    (button() as HTMLButtonElement).focus();
    fireEvent.click(button() as HTMLButtonElement);
    const home = view.container.querySelector("#home") as HTMLElement;
    home.focus();

    answer({ state: "spot_unavailable" });

    expect(document.activeElement).toBe(home);
  });

  test("shows the action's public failure and keeps the button", () => {
    const { button, fallback, options, view } = renderRetry();

    act(() => {
      options.onError({ error: { serverError: "Public failure" } });
    });

    expect(view.getByRole("alert").textContent).toBe("Public failure");
    expect(button()).not.toBeNull();
    expect(fallback()).toBeNull();
  });

  test.each([
    {
      name: "a failure without a public message",
      fail: (options: ActionOptions) => options.onError({ error: {} }),
    },
    {
      name: "a transport failure",
      fail: (options: ActionOptions) => options.onTransportError(),
    },
    {
      name: "a rejected input",
      fail: (options: ActionOptions) => options.onSuccess({}),
    },
  ])("shows a failure after $name", ({ fail }) => {
    const { options, view } = renderRetry();

    act(() => {
      fail(options);
    });

    expect(view.getByRole("alert").textContent).not.toBe("");
    expect(workspaceRouterPush).not.toHaveBeenCalled();
  });

  test("clears the failure when the customer tries again", () => {
    const { clickButton, options, view } = renderRetry();
    act(() => {
      options.onTransportError();
    });

    clickButton();

    expect(view.getByRole("alert").textContent).toBe("");
  });
});
