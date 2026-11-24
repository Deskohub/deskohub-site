// Entry point of the sandbox probe image; build.ts bundles it to probe.mjs.
import { createServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Config from "effect/Config";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ProbeIdentity, ProbeLog, probeServer } from "./probe";

// Cloud Run sets PORT; 0 (an ephemeral port) serves the bundle tests.
const ListenPort = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 65535 })
);

const httpServer = NodeHttpServer.layerConfig(createServer, {
  port: Config.schema(ListenPort, "PORT").pipe(Config.withDefault(8080)),
});

NodeRuntime.runMain(
  Layer.launch(
    probeServer.pipe(
      Layer.provide(
        Layer.mergeAll(httpServer, ProbeIdentity.fromConfig, ProbeLog.stdout)
      )
    )
  )
);
