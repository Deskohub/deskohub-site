// Bundles the probe server into one Node ESM file, the only input of the
// probe image:
//   bun packages/workspace-infrastructure/sandbox-probe/build.ts --outdir <dir>
//   docker build -f packages/workspace-infrastructure/sandbox-probe/Dockerfile \
//     --build-arg PROBE_BUILD_VERSION=v1 <dir>
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: process.argv.slice(2),
  strict: true,
  options: { outdir: { type: "string" } },
});

if (values.outdir === undefined) {
  console.error("usage: bun sandbox-probe/build.ts --outdir <dir>");
  process.exit(2);
}

const result = await Bun.build({
  entrypoints: [`${import.meta.dir}/main.ts`],
  outdir: values.outdir,
  naming: { entry: "probe.mjs" },
  target: "node",
  format: "esm",
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}
