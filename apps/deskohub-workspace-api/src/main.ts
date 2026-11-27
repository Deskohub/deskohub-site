import "./temporal";
import {
  CallerContextLive,
  WorkspaceBackendLive,
  WorkspaceRpcHandlers,
} from "@deskohub/workspace-backend";
import {
  EmailPreferencesRpcs,
  WorkspaceRpcSerialization,
} from "@deskohub/workspace-rpc";
import { WorkspaceContainerTelemetryLive } from "@deskohub/workspace-telemetry";
import { Layer } from "effect";
import { HttpRouter } from "effect/http";
import { RpcServer } from "effect/rpc";
import {
  runWorkspaceServer,
  WorkspaceHttpServer,
  workspaceHttpRouterOptions,
} from "./http-server";
import { workspaceRoutes } from "./routes";
import { workspaceRpcOptions } from "./rpc-options";

const apiRoutes = RpcServer.layerHttp({
  ...workspaceRpcOptions,
  group: EmailPreferencesRpcs,
}).pipe(
  Layer.provide(
    Layer.mergeAll(
      WorkspaceRpcHandlers,
      CallerContextLive,
      WorkspaceRpcSerialization
    )
  ),
  Layer.provide(WorkspaceBackendLive)
);

runWorkspaceServer(
  HttpRouter.serve(workspaceRoutes(apiRoutes), workspaceHttpRouterOptions).pipe(
    Layer.provide(
      Layer.merge(WorkspaceHttpServer, WorkspaceContainerTelemetryLive)
    )
  )
);
