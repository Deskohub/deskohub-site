import { Schema } from "effect";
import type { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

/**
 * Every service the API's schemas need to decode or encode a request, a
 * success or an error, on the server or the client.
 */
export type ContractServices<Groups extends HttpApiGroup.Constraint> =
  | HttpApiEndpoint.ServerServices<HttpApiGroup.Endpoints<Groups>>
  | HttpApiEndpoint.ClientServices<HttpApiGroup.Endpoints<Groups>>;

/**
 * Accepts only an API whose schemas are typed and need no services: one
 * whose groups were widened, so its endpoints and their services are
 * unknown, or whose schemas need any service, fails to typecheck.
 */
export type ServiceFreeContract<Groups extends HttpApiGroup.Constraint> = [
  HttpApiGroup.Endpoints<Groups>,
] extends [never]
  ? { readonly contractEndpoints: "typed endpoints" }
  : [ContractServices<Groups>] extends [never]
    ? unknown
    : { readonly contractServices: ContractServices<Groups> };

/**
 * A reflected Administration API schema as the codec it is. Reflection types
 * every endpoint schema as `Schema.Top`, whose services are unknown, and
 * Effect has no checked way to rebuild a service-free codec from one. The
 * typed contract proves it instead: the Administration API's schemas need no
 * services (`administration-contract-codec.typecheck.ts`), and every other
 * API the tools reflect is a `ServiceFreeContract`. The codec keeps the
 * schema's own AST, so it parses exactly as the schema does.
 */
export const administrationContractCodec = (schema: Schema.Top) =>
  Schema.make<Schema.Codec<unknown, unknown>>(schema.ast);
