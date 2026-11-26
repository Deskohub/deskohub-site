import { describe, expect, test } from "bun:test";
import { Effect, Option } from "effect";
import { Headers } from "effect/http";
import { decodeCallerHeaders, InvalidCallerHeaders } from "./caller";
import { correlationIdHeader } from "./correlation";

const correlationId = "72823c14-d2de-4a19-94ec-8b70ad590242";
const headers = Headers.fromInput({
  [correlationIdHeader]: correlationId,
  "x-deskohub-locale": "cs-CZ",
});

describe("caller header decoding", () => {
  test("decodes the anonymous caller and ignores ambient HTTP headers", async () => {
    const caller = await Effect.runPromise(
      decodeCallerHeaders(
        Headers.merge(
          headers,
          Headers.fromInput({
            "x-deskohub-client-address": "2001:db8::42",
            "x-deskohub-user-agent": "Deskohub Fixture/1.0",
            "x-forwarded-for": "192.0.2.60",
            "user-agent": "transport-agent",
          })
        )
      )
    );

    expect(caller).toEqual({
      correlationId,
      locale: "cs-CZ",
      clientAddress: Option.some("2001:db8::42"),
      userAgent: Option.some("Deskohub Fixture/1.0"),
    });
    expect(await Effect.runPromise(decodeCallerHeaders(headers))).toEqual({
      correlationId,
      locale: "cs-CZ",
      clientAddress: Option.none(),
      userAgent: Option.none(),
    });
  });

  for (const [name, value] of [
    [correlationIdHeader, correlationId],
    ["x-deskohub-locale", "cs-CZ"],
    ["x-deskohub-client-address", "192.0.2.60"],
    ["x-deskohub-user-agent", "Deskohub Fixture/1.0"],
  ]) {
    if (!name || !value) throw new Error("Invalid test headers");
    test(`rejects a repeated ${name} merged by Effect`, async () => {
      const otherHeaders = Headers.remove(headers, name);
      const merged = Headers.fromInput([
        ...Object.entries(otherHeaders),
        [name, value],
        [name.toUpperCase(), value],
      ]);
      expect(
        await Effect.runPromise(Effect.flip(decodeCallerHeaders(merged)))
      ).toBeInstanceOf(InvalidCallerHeaders);
    });
  }

  test("rejects invalid forwarding addresses, UUIDs and locales", async () => {
    for (const invalid of [
      Headers.set(headers, "x-deskohub-client-address", "192.0.2.1:81"),
      Headers.set(headers, correlationIdHeader, "caller"),
      Headers.set(headers, "x-deskohub-locale", "xx-XX"),
      Headers.remove(headers, correlationIdHeader),
    ]) {
      expect(
        await Effect.runPromise(Effect.flip(decodeCallerHeaders(invalid)))
      ).toBeInstanceOf(InvalidCallerHeaders);
    }
  });
});
