import { afterAll, afterEach, expect, test } from "bun:test";
import { m } from "@/features/i18n";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import { readPassPurchaseDraft } from "../pass-purchase-draft";

registerWorkspaceComponentTestEnv();
const { cleanup, render } = await import("@testing-library/react");
const { UnlimitedPassDetails } = await import("./unlimited-pass-details");

afterEach(cleanup);
afterAll(unregisterWorkspaceComponentTestEnv);

const locale = "en-US";

test("sign-in returns to Details with the carried tier, coffee and start date, and no contact details", () => {
  const view = render(
    <UnlimitedPassDetails
      buyer={{ kind: "signed-out" }}
      locale={locale}
      onChangeSelection={() => {}}
      onSubmit={async () => {}}
      selection={{
        tier: "open-space",
        coffee: true,
        startDate: plainDateStringSchema.make("2099-07-30"),
      }}
    />
  );
  const signIn = new URL(
    view
      .getByRole("link", { name: m.accountSignInTitle({}, { locale }) })
      .getAttribute("href") ?? "",
    "https://workspace.example"
  );
  expect(signIn.pathname).toBe("/en-US/auth/sign-in");
  const [returnTo] = [...signIn.searchParams.values()];
  const returned = new URL(returnTo ?? "", "https://workspace.example");
  expect(returned.pathname).toBe("/en-US/passes/unlimited");
  expect(returned.searchParams.get("step")).toBe("details");
  expect(
    readPassPurchaseDraft(Object.fromEntries(returned.searchParams))
  ).toEqual({ tier: "open-space", coffee: true, startDate: "2099-07-30" });
  for (const url of [signIn, returned]) {
    for (const key of url.searchParams.keys()) {
      expect(["name", "email", "phone", "billing", "contact"]).not.toContain(
        key
      );
    }
  }
});
