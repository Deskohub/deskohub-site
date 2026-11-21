import { HttpApiGroup } from "effect/http-api";
import { customerPassReadEndpoints } from "./customer-pass-reads-api";

/** Passes have their own catalog and orders, separate from booking. */
export const CustomerPassesApi = HttpApiGroup.make("passes")
  .add(...customerPassReadEndpoints)
  .prefix("/passes");
