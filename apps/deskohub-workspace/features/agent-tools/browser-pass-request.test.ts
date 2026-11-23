import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  containerDeploymentHost,
  mockDeploymentHost,
} from "@/shared/testing/deployment-host.test-utils";

const setDeploymentHost = await mockDeploymentHost();

const { serveBrowserPassRequest } = await import("./browser-pass-request");

/**
 * The status the origin check answers with. A request it lets through is a
 * plain-text body, which the next check refuses with 415 before any service
 * is used.
 */
const originCheckStatus = async (url: string, origin: string) => {
  const response = await Effect.runPromise(
    serveBrowserPassRequest(
      new Request(url, {
        method: "POST",
        headers: { origin, "content-type": "text/plain" },
      }),
      () => Effect.succeed(new Response(null, { status: 200 }))
      // Neither check reaches a service, so none is provided.
    ) as Effect.Effect<Response>
  );
  return response.status;
};

describe("serveBrowserPassRequest", () => {
  test("accepts only the request's own origin on Vercel", async () => {
    const url = "https://workspace.deskohub.cz/api/mcp/web";
    expect(await originCheckStatus(url, "https://workspace.deskohub.cz")).toBe(
      415
    );
    expect(await originCheckStatus(url, "https://attacker.example")).toBe(403);
  });

  describe("on a container", () => {
    // The container's server sees its listen address in the request URL.
    const listenUrl = "http://0.0.0.0:3000/api/mcp/web";

    beforeEach(() => {
      setDeploymentHost(containerDeploymentHost);
    });
    afterEach(() => {
      setDeploymentHost({});
    });

    test("accepts a browser on its public origin", async () => {
      expect(
        await originCheckStatus(listenUrl, "https://workspace-public.example")
      ).toBe(415);
    });

    test("rejects its listen origin and other origins", async () => {
      for (const origin of [
        "http://0.0.0.0:3000",
        "https://attacker.example",
        "null",
      ]) {
        expect(await originCheckStatus(listenUrl, origin)).toBe(403);
      }
    });
  });
});
