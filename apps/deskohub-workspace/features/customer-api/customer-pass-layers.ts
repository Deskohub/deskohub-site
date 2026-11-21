import { Context, Layer } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { CoworkPassesReleaseGateForRun } from "@/features/passes/backend/cowork-passes-release-gate";
import { CustomerPasses } from "@/features/passes/backend/customer-passes.service";
import { SharedAvailabilityInventoryLive } from "@/features/reservation/backend/availability-inventory-cache.server";
import { ReservationAccessService } from "@/features/reservation-access";
import { WorkspaceDotyposLayer } from "@/shared/backend/config/dotypos.config";

const livePassLayers = {
  passes: CustomerPasses.Default,
  release: CoworkPassesReleaseGateForRun,
  database: WorkspaceDatabase.Default,
  inventory: SharedAvailabilityInventoryLive,
  accessCodes: ReservationAccessService.Live,
  dotypos: WorkspaceDotyposLayer,
};

export type CustomerPassLayerSet = typeof livePassLayers;

export class CustomerPassLayers extends Context.Service<
  CustomerPassLayers,
  CustomerPassLayerSet
>()("@deskohub-workspace/customer-api/CustomerPassLayers") {
  static Live = this.withLayers({});

  static withLayers(layers: Partial<CustomerPassLayerSet>) {
    return Layer.succeed(CustomerPassLayers, { ...livePassLayers, ...layers });
  }
}
