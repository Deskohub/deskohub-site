import { describe, expect, test } from "bun:test";
import { cn, isClassValue } from "./utils";

describe("class values", () => {
  test("accepts every shape cn joins", () => {
    for (const value of [
      "focus-ring",
      ["focus-ring", ["nested"]],
      { active: true },
      0,
      false,
      null,
      undefined,
    ]) {
      expect(isClassValue(value)).toBe(true);
    }
    expect(cn("shrink-0", ["focus-ring", { active: true }])).toBe(
      "shrink-0 focus-ring active"
    );
  });

  test("rejects values cn would drop", () => {
    expect(isClassValue(() => "focus-ring")).toBe(false);
    expect(isClassValue(Symbol("focus-ring"))).toBe(false);
  });
});
