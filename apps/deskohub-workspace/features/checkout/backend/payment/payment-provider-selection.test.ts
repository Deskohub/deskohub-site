import { expect, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import { Effect } from "effect";
import { selectCheckoutPaymentProvider } from "./payment-provider-selection";

const syntheticCustomer = {
  name: "Synthetic customer",
  email: testEmailAddress("delivered+provider-selection"),
};

test("fallback applies between attempts only after the deployment gate activates", async () => {
  let active = false;
  const gate = Effect.sync(() => active);
  const select = () =>
    Effect.runPromise(
      selectCheckoutPaymentProvider("fallback", syntheticCustomer, gate)
    );

  expect(await select()).toBe("nexi");
  active = true;
  expect(await select()).toBe("mock");
  active = false;
  expect(await select()).toBe("nexi");
});

test("a regular checkout uses Nexi without checking the fallback gate", async () => {
  expect(
    await Effect.runPromise(
      selectCheckoutPaymentProvider(
        "fallback",
        { name: "Customer", email: "customer@example.test" },
        Effect.die("Regular checkout must not read the fallback gate.")
      )
    )
  ).toBe("nexi");
});

test("direct modes ignore the fallback gate", async () => {
  for (const mode of ["nexi", "mock"] as const) {
    expect(
      await Effect.runPromise(
        selectCheckoutPaymentProvider(
          mode,
          syntheticCustomer,
          Effect.die("Direct selection must not read the fallback gate.")
        )
      )
    ).toBe(mode);
  }
});
