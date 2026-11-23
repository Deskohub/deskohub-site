// Entry point of the sandbox probe image; see probe.mjs.
import { createProbeServer, defaultOtlpEndpoint, stdoutLog } from "./probe.mjs";

const version = process.env.PROBE_BUILD_VERSION || "dev";
const port = Number(process.env.PORT || 8080);
const otlpEndpoint = process.env.WORKSPACE_OTLP_ENDPOINT || defaultOtlpEndpoint;

const { server, attemptTrace } = createProbeServer({ version, otlpEndpoint });

server.listen(port, "0.0.0.0", () => {
  stdoutLog({
    severity: "INFO",
    message: "sandbox probe listening",
    probeVersion: version,
    port,
  });
  attemptTrace();
});

process.on("SIGTERM", () => {
  stdoutLog({ severity: "INFO", message: "sandbox probe stopping" });
  server.close(() => process.exit(0));
});
