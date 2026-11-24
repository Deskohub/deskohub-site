import type { WorkspaceAdminApi } from "@deskohub/workspace-admin-api";
import { Context, Effect, Schema, SchemaGetter } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import type {
  ContractServices,
  ServiceFreeContract,
} from "./administration-contract-codec";

type Expect<T extends true> = T;

type GroupsOf<Api> =
  Api extends HttpApi.HttpApi<string, infer Groups> ? Groups : never;

/** Whether `ServiceFreeContract` accepts the API's groups. */
type Accepted<Api> =
  unknown extends ServiceFreeContract<GroupsOf<Api>> ? true : false;

// The reflected codecs assume the Administration API's schemas need no
// services; one that needs any fails here.
type _AdministrationContractIsServiceFree = Expect<
  [ContractServices<GroupsOf<typeof WorkspaceAdminApi>>] extends [never]
    ? true
    : false
>;
type _AdministrationContractIsAccepted = Expect<
  Accepted<typeof WorkspaceAdminApi>
>;

void (() => {
  class RequiredService extends Context.Service<
    RequiredService,
    { readonly n: number }
  >()("administration-contract-codec.typecheck/RequiredService") {}
  const Counted = Schema.Struct({ n: Schema.Finite });
  const needsService = HttpApiEndpoint.get("needsService", "/needs", {
    success: Counted.pipe(
      Schema.decodeTo(Counted, {
        decode: SchemaGetter.transformEffect(() =>
          Effect.gen(function* () {
            const { n } = yield* RequiredService;
            return { n };
          })
        ),
        encode: SchemaGetter.transform((counted) => counted),
      })
    ),
  });
  const plain = HttpApiGroup.make("plain").add(
    HttpApiEndpoint.get("ok", "/ok")
  );
  const eraseGroup = (
    group: HttpApiGroup.Constraint
  ): HttpApiGroup.Constraint => group;
  const eraseEndpoint = (
    endpoint: HttpApiEndpoint.Constraint
  ): HttpApiEndpoint.Constraint => endpoint;
  const withService = HttpApiGroup.make("withService").add(needsService);

  const plainApi = HttpApi.make("plain").add(plain);
  const emptyApi = HttpApi.make("empty").add(HttpApiGroup.make("empty"));
  const serviceApi = HttpApi.make("service").add(withService);
  const widenedApi = HttpApi.make("widened").add(eraseGroup(withService));
  const mixedApi = HttpApi.make("mixed").add(plain, eraseGroup(withService));
  const erasedEndpointApi = HttpApi.make("erasedEndpoint").add(
    HttpApiGroup.make("erasedEndpoint").add(eraseEndpoint(needsService))
  );

  type _PlainIsAccepted = Expect<Accepted<typeof plainApi>>;
  type _EmptyIsAccepted = Expect<Accepted<typeof emptyApi>>;
  type _ServiceIsRefused = Expect<
    Accepted<typeof serviceApi> extends false ? true : false
  >;
  type _WidenedGroupIsRefused = Expect<
    Accepted<typeof widenedApi> extends false ? true : false
  >;
  type _MixedGroupsAreRefused = Expect<
    Accepted<typeof mixedApi> extends false ? true : false
  >;
  type _ErasedEndpointIsRefused = Expect<
    Accepted<typeof erasedEndpointApi> extends false ? true : false
  >;
});
