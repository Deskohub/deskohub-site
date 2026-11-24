import { afterEach, expect, test } from "bun:test";
import { stubFetch } from "./fetch-stub.test-utils";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("answers fetch with the stub", async () => {
  const fetchSpy = stubFetch(() => Promise.resolve(new Response("stubbed")));

  const response = await fetch("https://example.invalid/resource");

  expect(await response.text()).toBe("stubbed");
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

test("a later stub replaces the earlier one and holds only its own calls", async () => {
  stubFetch(() => Promise.resolve(new Response("first")));
  await fetch("https://example.invalid/first");
  const fetchSpy = stubFetch(() => Promise.resolve(new Response("second")));

  const response = await fetch("https://example.invalid/second");

  expect(await response.text()).toBe("second");
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});
