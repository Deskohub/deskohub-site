import type { WorkspaceAdminApi } from "@deskohub/workspace-admin-api";
import type { HttpApi } from "effect/http-api";
import type { ContractServices } from "./administration-contract-codec";

type Expect<T extends true> = T;

type AdministrationGroups =
  typeof WorkspaceAdminApi extends HttpApi.HttpApi<string, infer Groups>
    ? Groups
    : never;

// The reflected codecs assume the Administration API's schemas need no
// services; one that needs any fails here.
type _AdministrationContractIsServiceFree = Expect<
  [ContractServices<AdministrationGroups>] extends [never] ? true : false
>;
