import "./shared/polyfills/temporal";

import { logs } from "@opentelemetry/api-logs";
import { registerOTel } from "@vercel/otel";
import { env } from "./env";
import {
  flushWorkspaceTraces,
  workspaceLoggerProvider,
  workspaceOTelRegistration,
} from "./shared/backend/observability/workspace-telemetry";
import { runStandaloneWorkspaceEffect } from "./shared/backend/standalone-workspace-effect";
import {
  installRuntimeShutdown,
  onRuntimeShutdown,
} from "./shared/deployment/runtime-lifecycle";

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  registerOTel(workspaceOTelRegistration());

  const loggerProvider = workspaceLoggerProvider();
  if (loggerProvider) logs.setGlobalLoggerProvider(loggerProvider);

  // A container keeps serving until SIGTERM; Vercel ends invocations itself.
  if (env.WORKSPACE_RUNTIME_HOST !== "container") return;
  onRuntimeShutdown({
    name: "telemetry.traces",
    stage: "flush",
    run: flushWorkspaceTraces,
  });
  installRuntimeShutdown({
    run: runStandaloneWorkspaceEffect("runtime.shutdown"),
    exit: (code) => process.exit(code),
  });
}
