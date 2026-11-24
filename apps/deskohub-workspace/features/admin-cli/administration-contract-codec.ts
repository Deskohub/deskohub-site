import { Schema } from "effect";
import type { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

/**
 * Every service the API's schemas need to decode or encode a request, a
 * success or an error, on the server or the client.
 */
export type ContractServices<Groups extends HttpApiGroup.Constraint> =
  | HttpApiEndpoint.ServerServices<HttpApiGroup.Endpoints<Groups>>
  | HttpApiEndpoint.ClientServices<HttpApiGroup.Endpoints<Groups>>;

/** A group whose identifier was widened to `string`, losing its endpoints' types. */
type ErasedGroup<Group> = Group extends HttpApiGroup.Constraint
  ? string extends HttpApiGroup.Identifier<Group>
    ? Group
    : never
  : never;

/** An endpoint whose identifier was widened to `string`, losing its schemas' types. */
type ErasedEndpoint<Endpoint> = Endpoint extends HttpApiEndpoint.Constraint
  ? string extends HttpApiEndpoint.Identifier<Endpoint>
    ? Endpoint
    : never
  : never;

/**
 * Accepts only an API whose schemas are typed and need no services. An API
 * with a group or endpoint widened to its constraint, whose services are then
 * unknown, or whose schemas need any service, fails to typecheck. A group
 * with no endpoints is typed, and passes.
 */
export type ServiceFreeContract<Groups extends HttpApiGroup.Constraint> = [
  ErasedGroup<Groups> | ErasedEndpoint<HttpApiGroup.Endpoints<Groups>>,
] extends [never]
  ? [ContractServices<Groups>] extends [never]
    ? unknown
    : { readonly contractServices: ContractServices<Groups> }
  : {
      readonly erasedContract:
        | ErasedGroup<Groups>
        | ErasedEndpoint<HttpApiGroup.Endpoints<Groups>>;
    };

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
