import { describe, expect, test } from "bun:test";
import { byStage, selectDeploymentStageSetting } from "./deployment-stage";

const choices = { production: "production", otherwise: "otherwise" } as const;

describe("byStage", () => {
  test("selects the production value only on a production deployment", () => {
    expect(byStage("production", choices)).toBe("production");
    expect(byStage("preview", choices)).toBe("otherwise");
    expect(byStage("development", choices)).toBe("otherwise");
  });

  test("selects the otherwise value when the stage is missing", () => {
    // @ts-expect-error Exercise a missing deployment stage at runtime.
    expect(byStage(undefined, choices)).toBe("otherwise");
  });
});

describe("selectDeploymentStageSetting", () => {
  test("keeps Vercel's stage when no Workspace stage is set", () => {
    expect(selectDeploymentStageSetting({ VERCEL_ENV: "preview" })).toBe(
      "preview"
    );
  });

  test("prefers the Workspace stage a container host sets", () => {
    expect(
      selectDeploymentStageSetting({
        WORKSPACE_DEPLOYMENT_STAGE: "production",
        VERCEL_ENV: undefined,
      })
    ).toBe("production");
    expect(
      selectDeploymentStageSetting({
        WORKSPACE_DEPLOYMENT_STAGE: "preview",
        VERCEL_ENV: "production",
      })
    ).toBe("preview");
  });

  test("treats an empty Workspace stage as unset", () => {
    expect(
      selectDeploymentStageSetting({
        WORKSPACE_DEPLOYMENT_STAGE: "",
        VERCEL_ENV: "development",
      })
    ).toBe("development");
  });
});
