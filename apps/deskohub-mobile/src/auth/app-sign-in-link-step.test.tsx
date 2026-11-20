import { describe, expect, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import { findAll, textOf } from "../ui/testing/element-tree";
import { AppSignInLinkStep } from "./app-sign-in-link-step";
import { inOrder, shownTree } from "./testing/sign-in-step-tree";

const email = testEmailAddress("link");
const step = (props: Partial<Parameters<typeof AppSignInLinkStep>[0]> = {}) =>
  shownTree(AppSignInLinkStep, {
    email,
    notice: undefined,
    resendAvailableAt: Date.now() + 28_000,
    onResend: () => undefined,
    resending: false,
    onUseDifferentEmail: () => undefined,
    ...props,
  });

describe("AppSignInLinkStep", () => {
  test("names the link to open, waits to resend it, and has no bottom action", () => {
    const waiting = step();
    const text = findAll(waiting, "Text").map(textOf);
    expect(text).toContain(
      `We sent a sign-in link to ${email}. Open it on this device to sign in.`
    );
    expect(text.some((line) => line.startsWith("Resend link in "))).toBe(true);
    expect(inOrder(waiting).some(({ props }) => props.role === "link")).toBe(
      true
    );
    expect(inOrder(waiting).some(({ props }) => props.role === "button")).toBe(
      false
    );

    const available = step({ resendAvailableAt: Date.now() - 1 });
    const actions = inOrder(available).filter(
      ({ props }) => props.role === "button"
    );
    expect(actions).toHaveLength(1);
    expect(findAll(actions[0], "Text").map(textOf)).toContain("Resend link");
  });

  test("announces when a new link has been sent", () => {
    const notice = { tone: "positive", text: "sent" } as const;
    const status = inOrder(step({ notice })).find(
      ({ props }) => props.role === "status"
    );
    expect(status && textOf(status)).toBe("sent");
  });

  test("starting over waits while a link is sent", () => {
    const link = inOrder(step({ resending: true })).find(
      ({ props }) => props.role === "link"
    );
    expect(link?.props["aria-disabled"]).toBe(true);
  });
});
