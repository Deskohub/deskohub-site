import { expect, mock, spyOn, test } from "bun:test";
import { RegistryContext } from "@effect/atom-react";
import type { NativeStackNavigationOptions } from "expo-router";
import type { AriaAttributes, ReactElement } from "react";
import type { PressableProps, ViewProps } from "react-native";
import * as ReactNative from "react-native";
import {
  orderStatusHref,
  reservationsHref,
} from "../../booking/booking-routes";
import { accountAtom } from "../../customer-api/customer-data-runtime";
import {
  makeFakeCustomerData,
  settle,
} from "../../customer-api/testing/customer-data-test-registry";
import { FakeWorkspace } from "../../customer-api/testing/fake-workspace";
import { withSampleHistory } from "../../customer-api/testing/sample-history";
import { AppLocaleProvider } from "../../i18n/locale-context";
import { clientRoot } from "../../testing/client-root";
import { expoRouterStandIn } from "../../testing/expo-router-stand-in";
import { TestWindowDimensions } from "../../testing/window-dimensions";
import { elementTree, find } from "../../ui/testing/element-tree";
import { reservationHistoryAtom } from "./reservations-list-state";

let params: { orderId: string; after?: string } = { orderId: "" };
let screenOptions: NativeStackNavigationOptions | undefined;
const router = {
  push: mock((_href: unknown) => {}),
  replace: mock((_href: unknown) => {}),
  dismissTo: mock((_href: unknown) => {}),
  back: mock(() => {}),
  canGoBack: () => true,
};

mock.module("expo-router", () => ({
  ...expoRouterStandIn({
    useLocalSearchParams: () => params,
    useRouter: () => router,
  }),
  Stack: {
    Screen: ({ options }: { options: NativeStackNavigationOptions }) => {
      screenOptions = options;
      return null;
    },
  },
}));

// React DOM needs plain styles where native View permits falsy values and
// Pressable accepts a callback. Keep the pane width and row semantics.
const nativeStandIn = { ...ReactNative };
mock.module("react-native", () => ({
  ...nativeStandIn,
  View: ({ children, style, ...props }: ViewProps) => {
    const flat = ReactNative.StyleSheet.flatten(style);
    return (
      <div
        role={props.role}
        aria-hidden={props["aria-hidden"]}
        style={{
          display: flat?.display,
          width: typeof flat?.width === "number" ? flat.width : undefined,
        }}
      >
        {children}
      </div>
    );
  },
  Pressable: ({
    children,
    ...props
  }: PressableProps & Pick<AriaAttributes, "aria-current">) => (
    <div
      role={props.role}
      aria-current={props["aria-current"]}
      data-native-selected={props["aria-selected"]}
    >
      {typeof children === "function"
        ? children({ pressed: false, hovered: false })
        : children}
    </div>
  ),
}));

const { default: ReservationsRoute } = await import(
  "../../../app/(account)/(tabs)/reservations/index"
);
const { default: ReservationStatusRoute } = await import(
  "../../../app/(account)/(tabs)/reservations/[orderId]/index"
);
const { OrderStatusScreen, ReservationPaneHeading } = await import(
  "./order-status-screen"
);
const { ReservationsListScreen } = await import("./reservations-list-screen");
const { StatusBarObserverContext } = await import(
  "../../ui/focused-status-bar"
);
const { SplitPane } = await import("../../ui/split-pane");
const { ToastProvider } = await import("../../ui/toast");

const root = clientRoot({ keepFetch: true });

const fixture = async (history: "upcoming" | "empty") => {
  const workspace = withSampleHistory(FakeWorkspace.forKind("linked"), history);
  const { registry } = makeFakeCustomerData("linked", workspace);
  registry.mount(accountAtom);
  registry.mount(reservationHistoryAtom);
  await settle(registry, accountAtom);
  await settle(registry, reservationHistoryAtom);
  const statusBars = new Map<symbol, "dark" | "light">();
  const observe = (style: "dark" | "light") => {
    const owner = Symbol();
    statusBars.set(owner, style);
    return () => statusBars.delete(owner);
  };
  const within = (width: number, node: ReactElement) => (
    <TestWindowDimensions
      value={{ width, height: 800, scale: 2, fontScale: 2 }}
    >
      <RegistryContext.Provider value={registry}>
        <AppLocaleProvider locale="en-US">
          <StatusBarObserverContext value={observe}>
            <ToastProvider>{node}</ToastProvider>
          </StatusBarObserverContext>
        </AppLocaleProvider>
      </RegistryContext.Provider>
    </TestWindowDimensions>
  );
  const { error } = console;
  const warnings = spyOn(console, "error").mockImplementation((...args) => {
    if (
      !/incorrect casing|does not recognize the|non-boolean attribute|unrecognized in this browser|Unknown event handler property/.test(
        String(args[0])
      )
    ) {
      error(...args);
    }
  });
  return {
    workspace,
    within,
    statusBars,
    render: (width: number, node: ReactElement) =>
      root.render(within(width, node)),
    dispose: async () => {
      await root.render(null);
      warnings.mockRestore();
      registry.dispose();
    },
  };
};

test("an empty Reservations list leaves the expanded detail blank", async () => {
  const screen = await fixture("empty");
  try {
    await screen.render(1024, <ReservationsRoute />);
    expect(root.container().querySelectorAll("scrollview")).toHaveLength(1);
    expect(root.container().querySelector("[aria-current]")).toBeNull();
    expect(root.container().querySelector('[style*="400px"]')).not.toBeNull();
    expect([...screen.statusBars.values()]).toEqual(["dark"]);
  } finally {
    await screen.dispose();
  }
});

test("a linked detail and its selected row survive the split breakpoint at 200% font size", async () => {
  const screen = await fixture("upcoming");
  const orderId = screen.workspace.data.history.current[0]?.orderId;
  if (orderId === undefined) throw new Error("Expected a selectable booking");
  params = { orderId };
  try {
    await screen.render(1023, <ReservationStatusRoute />);
    expect(screenOptions?.headerShown).toBe(true);
    const detail = root.container().querySelector("scrollview");
    expect(detail).not.toBeNull();
    await screen.render(1024, <ReservationStatusRoute />);
    expect(screenOptions?.headerShown).toBe(false);
    expect(root.container().querySelectorAll("scrollview")).toHaveLength(2);
    expect(root.container().querySelector('[style*="400px"]')).not.toBeNull();
    const selected = root.container().querySelectorAll('[aria-current="page"]');
    expect(selected).toHaveLength(1);
    expect(selected[0]?.getAttribute("data-native-selected")).toBe("true");
    expect([...screen.statusBars.values()]).toEqual(["dark"]);
    await screen.render(600, <ReservationStatusRoute />);
    expect(screenOptions?.headerShown).toBe(true);
    expect(root.container().querySelectorAll("scrollview")).toHaveLength(1);
    expect(root.container().querySelector("scrollview")).toBe(detail);
    expect(router.replace).not.toHaveBeenCalled();
  } finally {
    await screen.dispose();
  }
});

test("selecting another wide booking replaces the route and payment return closes to Reservations", async () => {
  const screen = await fixture("upcoming");
  const [first, second] = screen.workspace.data.history.current;
  if (first?.orderId === undefined || second?.orderId === undefined) {
    throw new Error("Expected two selectable bookings");
  }
  params = { orderId: first.orderId, after: "payment" };
  try {
    const tree = elementTree(ReservationStatusRoute, {}, (node) =>
      screen.within(1024, node)
    );
    const split = find(tree, SplitPane)?.props;
    const list = find(split?.list, ReservationsListScreen)?.props?.selection;
    list?.onSelect(first.orderId);
    expect(router.replace).not.toHaveBeenCalled();
    list?.onSelect(second.orderId);
    expect(router.replace).toHaveBeenCalledWith(
      orderStatusHref(second.orderId)
    );
    const heading = find(
      find(split?.children, OrderStatusScreen)?.props.heading,
      ReservationPaneHeading
    );
    expect(heading?.props.closes).toBe(true);
    heading?.props.onBack?.();
    expect(router.dismissTo).toHaveBeenCalledWith(reservationsHref);
    expect(router.back).not.toHaveBeenCalled();
  } finally {
    await screen.dispose();
  }
});
