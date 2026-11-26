import { expect, test } from "bun:test";

test("the RPC and testing exports bundle without server or provider modules", async () => {
  const forbidden =
    /^(?:node:|bun:|server-only$|(?:bun|effect-rpc-baseline|next|react|react-dom|better-auth|jose|drizzle-orm|pg|postgres)(?:\/|$)|@\/|@(?:better-auth|google-cloud|vercel)\/|@deskohub\/(?!i18n\/locale-registry$)|(?:.*\/)?apps\/)/;

  const bundled = await Bun.build({
    entrypoints: [
      new URL("./src/index.ts", import.meta.url).pathname,
      new URL("./src/testing.ts", import.meta.url).pathname,
    ],
    target: "browser",
    plugins: [
      {
        name: "workspace-rpc-contract",
        setup(build) {
          build.onResolve({ filter: forbidden }, (args) => {
            throw new Error(
              `Import ${args.path} reached from ${args.importer}`
            );
          });
        },
      },
    ],
  });

  expect(bundled.success).toBe(true);
});
