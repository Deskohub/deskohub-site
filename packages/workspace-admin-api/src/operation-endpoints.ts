import {
  Effect,
  type Layer,
  Option,
  Schema,
  type Scope,
  Struct,
  type Types,
} from "effect";
import {
  HttpMethod,
  type HttpRouter,
  type HttpServerRequest,
} from "effect/http";
import { HttpApi, type HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { administrationInputParseOptions } from "./administration-input-parse-options";
import {
  AdministrationOperationBehavior,
  readOperation,
} from "./administration-operation";
import type {
  Operation,
  OperationInput,
  OperationOutput,
  Operations,
} from "./administration-operation-port";
import type { NoInput } from "./campaign-operations";
import { MinimumDhwVersion } from "./dhw-version";

/** The names of a path's `:name` segments. */
export type PathParamNames<Path extends string> =
  Path extends `${string}:${infer Param}/${infer Rest}`
    ? Param | PathParamNames<`/${Rest}`>
    : Path extends `${string}:${infer Param}`
      ? Param
      : never;

const pathParamNamesOf = (path: string): ReadonlyArray<string> =>
  Array.from(path.matchAll(/:(\w+)/g), ([, name]) => name ?? "");

/** `unknown` when `Keys` are exactly the path's parameters, else why not. */
type ParamsProblem<Path extends string, Keys extends string> = [
  Exclude<PathParamNames<Path>, Keys>,
] extends [never]
  ? [Exclude<Keys, PathParamNames<Path>>] extends [never]
    ? unknown
    : `the path names no :${Exclude<Keys, PathParamNames<Path>>}`
  : `the path parameters omit ${Exclude<PathParamNames<Path>, Keys>}`;

/** `unknown` when `Fields` has nothing beyond `Keys`, else why not. */
type NothingBeyond<Fields, Keys> = [Exclude<keyof Fields, Keys>] extends [never]
  ? unknown
  : `${Exclude<keyof Fields, Keys> & string} has no place in the request`;

/** `unknown` when `Fields` has something beyond `Keys`, else why not. */
type SomethingBeyond<Fields, Keys> = [Exclude<keyof Fields, Keys>] extends [
  never,
]
  ? "there is no input beyond the path"
  : unknown;

/** Throws unless `keys` are exactly the parameters `path` names. */
const checkedParams = <const Keys extends ReadonlyArray<string>>(
  path: string,
  keys: Keys
): Keys => {
  const named = pathParamNamesOf(path);
  if (
    named.length !== keys.length ||
    !named.every((name) => keys.includes(name))
  ) {
    throw new Error(
      `${path} names ${named.join(", ")}, not ${keys.join(", ")}.`
    );
  }
  return keys;
};

type StructOperation<
  Name extends string,
  Fields extends Schema.Struct.Fields,
  Output extends Schema.Top,
> = Operation<Name, Schema.Struct<Fields>, Output>;

/*
 * The request parts of an operation's endpoint, as the arguments of the
 * `HttpApiEndpoint` constructor of its method:
 * `HttpApiEndpoint.post(...bodyRequest(operation, "/path", errors))`.
 * Path parameters are the input fields the path names; a read carries the
 * rest as its query, a write as its body, which is the whole input when the
 * path names none. Each checks its keys name exactly the path's parameters.
 */

/** An endpoint whose request carries no input. */
export const bareRequest = <
  const Name extends string,
  Output extends Schema.Top,
  const Path extends HttpRouter.PathInput,
  const Errors extends ReadonlyArray<Schema.Top>,
>(
  operation: Operation<Name, typeof NoInput, Output>,
  path: Path & ParamsProblem<Path, never>,
  errors: Errors
) => {
  checkedParams(path, []);
  return [
    operation.name,
    path,
    { success: operation.output, error: errors },
  ] as const;
};

/** An endpoint whose path parameters are its whole input. */
export const paramsRequest = <
  const Name extends string,
  Fields extends Schema.Struct.Fields,
  Output extends Schema.Top,
  const Path extends HttpRouter.PathInput,
  const Keys extends ReadonlyArray<keyof Fields & string>,
  const Errors extends ReadonlyArray<Schema.Top>,
>(
  operation: StructOperation<Name, Fields, Output>,
  path: Path & ParamsProblem<Path, Keys[number]>,
  keys: Keys & NothingBeyond<Fields, Keys[number]>,
  errors: Errors
) =>
  [
    operation.name,
    path,
    {
      params: Struct.pick(operation.input.fields, checkedParams(path, keys)),
      success: operation.output,
      error: errors,
    },
  ] as const;

/** A read without path parameters, its input the query. */
export const queryRequest = <
  const Name extends string,
  Fields extends Schema.Struct.Fields,
  Output extends Schema.Top,
  const Path extends HttpRouter.PathInput,
  const Errors extends ReadonlyArray<Schema.Top>,
>(
  operation: StructOperation<Name, Fields, Output>,
  path: Path & ParamsProblem<Path, never> & SomethingBeyond<Fields, never>,
  errors: Errors
) => {
  checkedParams(path, []);
  return [
    operation.name,
    path,
    { query: operation.input, success: operation.output, error: errors },
  ] as const;
};

/** A read carrying its input beyond the path parameters as its query. */
export const paramsQueryRequest = <
  const Name extends string,
  Fields extends Schema.Struct.Fields,
  Output extends Schema.Top,
  const Path extends HttpRouter.PathInput,
  const Keys extends ReadonlyArray<keyof Fields & string>,
  const Errors extends ReadonlyArray<Schema.Top>,
>(
  operation: StructOperation<Name, Fields, Output>,
  path: Path & ParamsProblem<Path, Keys[number]>,
  keys: Keys,
  errors: Errors
) => {
  const params = checkedParams(path, keys);
  return [
    operation.name,
    path,
    {
      params: Struct.pick(operation.input.fields, params),
      query: operation.input.mapFields(Struct.omit(params)),
      success: operation.output,
      error: errors,
    },
  ] as const;
};

/** A write without path parameters, its input the body. */
export const bodyRequest = <
  const Name extends string,
  Fields extends Schema.Struct.Fields,
  Output extends Schema.Top,
  const Path extends HttpRouter.PathInput,
  const Errors extends ReadonlyArray<Schema.Top>,
>(
  operation: StructOperation<Name, Fields, Output>,
  path: Path & ParamsProblem<Path, never> & SomethingBeyond<Fields, never>,
  errors: Errors
) => {
  checkedParams(path, []);
  return [
    operation.name,
    path,
    { payload: operation.input, success: operation.output, error: errors },
  ] as const;
};

/** A write carrying its input beyond the path parameters as its body. */
export const paramsBodyRequest = <
  const Name extends string,
  Fields extends Schema.Struct.Fields,
  Output extends Schema.Top,
  const Path extends HttpRouter.PathInput,
  const Keys extends ReadonlyArray<keyof Fields & string>,
  const Errors extends ReadonlyArray<Schema.Top>,
>(
  operation: StructOperation<Name, Fields, Output>,
  path: Path & ParamsProblem<Path, Keys[number]>,
  keys: Keys & SomethingBeyond<Fields, Keys[number]>,
  errors: Errors
) => {
  const params = checkedParams(path, keys);
  return [
    operation.name,
    path,
    {
      params: Struct.pick(operation.input.fields, params),
      payload: operation.input.mapFields(Struct.omit(params)),
      success: operation.output,
      error: errors,
    },
  ] as const;
};

/**
 * A write whose body is the one input field beyond its path parameters;
 * its endpoint serves the operation with `{ body: field }`.
 */
export const paramsFieldRequest = <
  const Name extends string,
  Fields extends Schema.Struct.Fields,
  Output extends Schema.Top,
  const Path extends HttpRouter.PathInput,
  const Keys extends ReadonlyArray<keyof Fields & string>,
  const Field extends keyof Fields & string,
  const Errors extends ReadonlyArray<Schema.Top>,
>(
  operation: StructOperation<Name, Fields, Output>,
  path: Path & ParamsProblem<Path, Keys[number]>,
  keys: Keys & NothingBeyond<Fields, Keys[number] | Field>,
  field: Field,
  errors: Errors
) =>
  [
    operation.name,
    path,
    {
      params: Struct.pick(operation.input.fields, checkedParams(path, keys)),
      payload: operation.input.fields[field],
      success: operation.output,
      error: errors,
    },
  ] as const;

/** What a route's body carries: one input field, the rest of the input, or nothing. */
type RequestBody =
  | { readonly _tag: "Field"; readonly field: string }
  | { readonly _tag: "Rest" }
  | { readonly _tag: "None" };

/** Where an endpoint's request places its operation's input. */
interface RequestLayout {
  readonly paramKeys: ReadonlyArray<string>;
  readonly query: boolean;
  readonly body: RequestBody;
}

/**
 * The one input field each operation's endpoint carries as its body, when
 * `servesOperation` declares one. An endpoint's other request parts follow
 * from the endpoint itself.
 */
const bodyFields = new WeakMap<Operation, string>();

type AdministrationBehavior = AdministrationOperationBehavior["Service"];

/** The behavior a mutation's endpoint declares; a ledgered one is idempotent. */
type MutationBehavior<Op extends Operation> = Exclude<
  AdministrationBehavior,
  { readonly kind: "read" }
> &
  (Op["ledger"] extends true ? { readonly idempotent: true } : unknown);

type FieldsOf<Input> =
  Input extends Schema.Struct<infer Fields extends Schema.Struct.Fields>
    ? Fields
    : Record<never, never>;

/**
 * How an endpoint serves its operation: a mutation states its behavior, a
 * query is always a read, and `body` names the one input field a
 * `paramsFieldRequest` body carries.
 */
export type ServedOperationOptions<
  Op extends Operation,
  Body extends keyof FieldsOf<Op["input"]> & string,
> = (Op["kind"] extends "query"
  ? { readonly behavior?: never }
  : { readonly behavior: MutationBehavior<Op> }) & {
  readonly body?: Body;
};

/**
 * The endpoint `endpoint`, named after `operation`, serving it: its request
 * reports every issue and refuses fields the input doesn't declare, it
 * declares the operation's behavior and minimum `dhw`, and it records where
 * its request carries the input for `operationGroupHandlers` and
 * `operationRequest`.
 */
export const servesOperation =
  <
    Op extends Operation,
    const Body extends keyof FieldsOf<Op["input"]> & string = never,
  >(
    operation: Op,
    ...[options]: Op["kind"] extends "query"
      ? [options?: ServedOperationOptions<Op, Body>]
      : [options: ServedOperationOptions<Op, Body>]
  ) =>
  <
    Method extends HttpMethod.HttpMethod,
    Path extends string,
    Params extends Schema.Top,
    Query extends Schema.Top,
    Payload extends Schema.Top,
    Headers extends Schema.Top,
    Success extends Schema.Top,
    Failure extends Schema.Top,
    Middleware,
    MiddlewareServices,
  >(
    endpoint: HttpApiEndpoint.HttpApiEndpoint<
      Op["name"],
      Method,
      Path,
      Params,
      Query,
      Payload,
      Headers,
      Success,
      Failure,
      Middleware,
      MiddlewareServices
    >
  ) => {
    const body = options?.body;
    if (operation.kind === "mutation" && options?.behavior === undefined) {
      throw new Error(`${operation.name} is a mutation without a behavior.`);
    }
    if (body !== undefined) {
      if (!HttpMethod.hasBody(endpoint.method)) {
        throw new Error(`${operation.name} carries ${body} without a body.`);
      }
      const declared = bodyFields.get(operation);
      if (declared !== undefined && declared !== body) {
        throw new Error(`${operation.name} already carries ${declared}.`);
      }
      bodyFields.set(operation, body);
    }
    const served = endpoint
      .annotate(HttpApi.PayloadParseOptions, administrationInputParseOptions)
      .annotate(HttpApi.QueryParseOptions, administrationInputParseOptions)
      .annotate(
        AdministrationOperationBehavior,
        options?.behavior ?? readOperation
      );
    return operation.minimumDhwVersion === undefined
      ? served
      : served.annotate(
          MinimumDhwVersion,
          Option.some(operation.minimumDhwVersion)
        );
  };

/** Runs an operation by name; `operationGroupHandlers` serves a group with it. */
export type OperationInvoke<Ops extends Operations, Failure, Services> = <
  Name extends keyof Ops & string,
>(
  name: Name,
  input: OperationInput<Ops[Name]>
) => Effect.Effect<OperationOutput<Ops[Name]>, Failure, Services>;

/** Adapts some operations' outputs for the caller. */
export type OutputAdapters<Ops extends Operations, Services> = {
  readonly [Name in keyof Ops & string]?: (
    output: OperationOutput<Ops[Name]>
  ) => Effect.Effect<OperationOutput<Ops[Name]>, never, Services>;
};

/** No operation's output adapted. */
type NoOutputs = Record<never, never>;

/** The services `Outputs`' adapters require. */
type OutputServices<Outputs> = {
  readonly [Name in keyof Outputs]-?: NonNullable<Outputs[Name]> extends (
    output: never
  ) => infer Adapted
    ? Effect.Services<Adapted>
    : never;
}[keyof Outputs];

/**
 * What serving `Endpoint` with a handler requiring `R1` requires, as
 * `HttpApiBuilder`'s `handleAll` adds it: its middleware and their
 * services, and the handler's services the request doesn't provide. Each
 * group's server is checked against it where the group is declared.
 */
type ServedRequirements<
  Endpoint extends HttpApiEndpoint.Constraint,
  R1,
  R = HttpApiEndpoint.ExcludeProvided<
    Endpoint,
    R1 | HttpApiEndpoint.ServerServices<Endpoint>
  >,
> =
  | HttpApiEndpoint.Middleware<Endpoint>
  | HttpApiEndpoint.MiddlewareServices<Endpoint>
  | ([R] extends [never] ? never : HttpRouter.Request.From<"Requires", R>);

/** The services decoding and encoding the input of the operation `Name` uses. */
type InputServices<Ops extends Operations, Name> = Name extends keyof Ops
  ? Ops[Name]["input"]["EncodingServices"]
  : never;

/** What serving every endpoint of `Group` requires. */
type GroupRequirements<
  Group extends HttpApiGroup.Constraint,
  Ops extends Operations,
  Services,
> =
  HttpApiGroup.Endpoints<Group> extends infer Endpoint
    ? Endpoint extends HttpApiEndpoint.Constraint
      ? ServedRequirements<
          Endpoint,
          Services | InputServices<Ops, HttpApiEndpoint.Identifier<Endpoint>>
        >
      : never
    : never;

/** The layer serving `Group` within the API `ApiId`. */
export type OperationGroupServer<
  Group extends HttpApiGroup.Constraint,
  Ops extends Operations,
> = <
  ApiId extends string,
  Groups extends HttpApiGroup.Constraint,
  Failure extends HttpApiEndpoint.Errors<HttpApiGroup.Endpoints<Group>>,
  E,
  R,
  Services,
  AdapterServices,
>(
  api: HttpApi.HttpApi<ApiId, Groups>,
  invoker: Effect.Effect<OperationInvoke<Ops, Failure, Services>, E, R>,
  outputs: OutputAdapters<Ops, AdapterServices> | undefined
) => Layer.Layer<
  HttpApiGroup.Service<ApiId, HttpApiGroup.Identifier<Group>>,
  E,
  Exclude<
    R | GroupRequirements<Group, Ops, Services | AdapterServices>,
    Scope.Scope
  >
>;

const operationBinding = Symbol.for(
  "@deskohub/workspace-admin-api/OperationBinding"
);

const operationServer = Symbol.for(
  "@deskohub/workspace-admin-api/OperationServer"
);

/** The operations a group serves, and the group serving them. */
export interface OperationBinding<
  Ops extends Operations = Operations,
  Group extends HttpApiGroup.Constraint = HttpApiGroup.Constraint,
> {
  readonly [operationBinding]: {
    readonly group: Group;
    readonly operations: Ops;
  };
}

/** The server of a group bound to its operations. */
export interface OperationServer<
  Group extends HttpApiGroup.Constraint,
  Ops extends Operations,
> {
  readonly [operationServer]: OperationGroupServer<Group, Ops>;
}

type OperationsOf<Group extends OperationBinding> =
  Group[typeof operationBinding]["operations"];

type BoundGroupOf<Group extends OperationBinding> =
  Group[typeof operationBinding]["group"];

/**
 * `group`, whose endpoints each serve the operation of their name in
 * `operations`, bound to them and to `serve`, the layer serving every
 * endpoint. Declare `serve` where the group is: `HttpApiBuilder.group` on
 * `operationGroupApi(api, group)`, its `handleAll` taking `operationHandler`'s
 * handler for each endpoint.
 */
/** Operations each named after its key, as a group's endpoints are. */
export type SelfNamedOperations<Ops> = {
  readonly [Name in keyof Ops]: Operation<Name & string>;
};

export const operationGroup = <
  Group extends HttpApiGroup.Constraint,
  Ops extends SelfNamedOperations<Ops> & Operations,
>(
  group: Group,
  operations: Ops,
  serve: OperationGroupServer<Group, Ops>
): Group & OperationBinding<Ops, Group> & OperationServer<Group, Ops> => {
  const { endpoints } = httpApiGroupOf(group);
  for (const [name, operation] of Object.entries(operations)) {
    if (operation.name !== name) {
      throw new Error(`${group.identifier}.${name} names ${operation.name}.`);
    }
    if (!Object.hasOwn(endpoints, name)) {
      throw new Error(`${group.identifier} serves no endpoint for ${name}.`);
    }
  }
  for (const name of Object.keys(endpoints)) {
    if (!Object.hasOwn(operations, name)) {
      throw new Error(`${group.identifier}.${name} serves no operation.`);
    }
  }
  const binding: OperationBinding<Ops, Group> & OperationServer<Group, Ops> = {
    [operationBinding]: { group, operations },
    [operationServer]: serve,
  };
  return Object.assign(group, binding);
};

/**
 * Whether `served` is `group` as an API serves it: `group` itself, or the
 * copy `addHttpApi` makes, which shares `group`'s endpoints and adds the
 * composed API's annotations. A group that only shares `group`'s identifier
 * and routes isn't it: its endpoints may decode and encode differently.
 */
const servesGroup =
  (group: HttpApiGroup.Top) =>
  (served: HttpApiGroup.Top): boolean =>
    served.identifier === group.identifier &&
    served.topLevel === group.topLevel &&
    served.endpoints === group.endpoints;

/**
 * The API serving `group` alone, as `api` declares it, for building the
 * group's handlers where its endpoints are known: `group` with the
 * annotations `api` serves it with. Throws unless `api` serves `group`.
 */
export const operationGroupApi = <
  ApiId extends string,
  Groups extends HttpApiGroup.Constraint,
  Id extends string,
  Endpoints extends HttpApiEndpoint.Constraint,
  TopLevel extends boolean,
>(
  api: HttpApi.HttpApi<ApiId, Groups>,
  group: HttpApiGroup.HttpApiGroup<Id, Endpoints, TopLevel>
) => {
  const served = Object.values(api.groups)
    .filter(HttpApiGroup.isHttpApiGroup)
    .find(servesGroup(httpApiGroupOf(group)));
  if (served === undefined) {
    throw new Error(`${api.identifier} doesn't serve ${group.identifier}.`);
  }
  return HttpApi.make(api.identifier)
    .add(group.annotateMerge(served.annotations))
    .annotateMerge(api.annotations);
};

/** An operation's input fields by name, before its schema decodes them. */
const InputFields = Schema.Record(Schema.String, Schema.Unknown);
type InputFields = typeof InputFields.Type;

/** The parts of a request that carry an operation's input. */
export const OperationRequest = Schema.Struct({
  params: Schema.optional(InputFields),
  query: Schema.optional(InputFields),
  payload: Schema.optional(Schema.Unknown),
});
export type OperationRequest = typeof OperationRequest.Type;

/** The value `body` names in `rest` or one of `fields`, or none. */
const bodyValue = <A>(
  body: RequestBody,
  rest: () => A,
  field: (name: string) => A
): A | undefined => {
  switch (body._tag) {
    case "None":
      return undefined;
    case "Rest":
      return rest();
    case "Field":
      return field(body.field);
  }
};

/** What the body of the endpoint serving `operation` carries. */
const bodyOf = (
  operation: Operation,
  endpoint: HttpApiEndpoint.Top
): RequestBody => {
  const field = bodyFields.get(operation);
  if (field !== undefined) return { _tag: "Field", field };
  return endpoint.payload.size > 0 ? { _tag: "Rest" } : { _tag: "None" };
};

/** `group` as the `HttpApiGroup` it is, its endpoints by identifier. */
const httpApiGroupOf = (group: HttpApiGroup.Constraint): HttpApiGroup.Top => {
  const declared: unknown = group;
  if (!HttpApiGroup.isHttpApiGroup(declared)) {
    throw new Error(`${group.identifier} isn't an HttpApiGroup.`);
  }
  return declared;
};

/** Where the endpoint serving `operation` in `group` places its input. */
const layoutOf = (
  group: HttpApiGroup.Constraint,
  operation: Operation
): RequestLayout => {
  const endpoint: HttpApiEndpoint.Top | undefined =
    httpApiGroupOf(group).endpoints[operation.name];
  if (endpoint === undefined) {
    throw new Error(`${group.identifier} serves no ${operation.name}.`);
  }
  return {
    paramKeys: pathParamNamesOf(endpoint.path),
    query: endpoint.query !== undefined,
    body: bodyOf(operation, endpoint),
  };
};

/** The request parts that carry an operation's input, as its layout places them. */
const requestOf = (
  { paramKeys, query, body }: RequestLayout,
  input: InputFields
): OperationRequest => {
  const rest = Struct.omit(input, paramKeys);
  const request: Types.Mutable<OperationRequest> = {};
  if (paramKeys.length > 0) request.params = Struct.pick(input, paramKeys);
  if (query) request.query = rest;
  if (body._tag !== "None") {
    request.payload = bodyValue(
      body,
      () => rest,
      (name) => input[name]
    );
  }
  return request;
};

/**
 * The request parts, params, query and payload, that carry the input of the
 * operation `name` to its endpoint in `group`: what a client of the group
 * sends.
 */
export const operationRequest = <
  Ops extends Operations,
  Name extends keyof Ops & string,
>(
  group: OperationBinding<Ops>,
  name: Name,
  input: OperationInput<Ops[Name]>
): OperationRequest => {
  const { group: served, operations } = group[operationBinding];
  const operation = operations[name];
  if (operation === undefined) {
    throw new Error(`${served.identifier} serves no ${name}.`);
  }
  if (!Schema.is(InputFields)(input)) {
    throw new Error(`${name} takes no struct input.`);
  }
  return requestOf(layoutOf(served, operation), input);
};

/** A request an endpoint's handler receives, its input parts decoded. */
type ServedRequest = OperationRequest & {
  readonly request: HttpServerRequest.HttpServerRequest;
};

/** The operation's input from the request parts its layout placed it in. */
const inputOf = (
  { body }: RequestLayout,
  request: OperationRequest
): InputFields =>
  body._tag === "Field"
    ? { ...request.params, [body.field]: request.payload }
    : {
        ...request.params,
        ...request.query,
        ...Schema.decodeUnknownOption(InputFields)(request.payload).pipe(
          Option.getOrElse((): InputFields => ({}))
        ),
      };

/**
 * The handler of the endpoint serving the operation `name` in `group`: it
 * runs the operation on the input the request carries, then `outputs`'
 * adapter of its output, as withholding what an older `dhw` can't decode.
 */
export const operationHandler =
  <Ops extends Operations, Failure, Services, AdapterServices>(
    group: HttpApiGroup.Constraint,
    operations: Ops,
    invoke: OperationInvoke<Ops, Failure, Services>,
    outputs: OutputAdapters<Ops, AdapterServices> | undefined
  ) =>
  <Name extends keyof Ops & string>(name: Name) => {
    const operation = operations[name];
    if (operation === undefined) {
      throw new Error(`${group.identifier}.${name} serves no operation.`);
    }
    const layout = layoutOf(group, operation);
    const { input } = operation;
    const adapt: (
      output: OperationOutput<Ops[Name]>
    ) => Effect.Effect<OperationOutput<Ops[Name]>, never, AdapterServices> =
      outputs?.[name] ?? Effect.succeed;
    return (
      request: ServedRequest
    ): Effect.Effect<
      OperationOutput<Ops[Name]>,
      Failure,
      Services | AdapterServices | Ops[Name]["input"]["EncodingServices"]
    > =>
      // The endpoint decoded each part; the port takes the encoded input
      // and decodes it again.
      Schema.encodeUnknownEffect(input)(inputOf(layout, request)).pipe(
        Effect.orDie,
        Effect.flatMap((encoded) => invoke(name, encoded)),
        Effect.flatMap(adapt)
      );
  };

/**
 * Serves every endpoint of an operation group by running the operation of
 * its name on the input its request carries. `outputs` adapts an
 * operation's output for the caller, as withholding what an older `dhw`
 * can't decode.
 */
export const operationGroupHandlers = <
  ApiId extends string,
  Groups extends HttpApiGroup.Constraint,
  Group extends Groups & OperationBinding,
  Failure extends HttpApiEndpoint.Errors<
    HttpApiGroup.Endpoints<BoundGroupOf<Group>>
  >,
  E,
  R,
  Services,
  Outputs extends OutputAdapters<
    OperationsOf<Group>,
    AdapterServices
  > = NoOutputs,
  AdapterServices = OutputServices<Outputs>,
>(
  api: HttpApi.HttpApi<ApiId, Groups>,
  group: Group & OperationServer<BoundGroupOf<Group>, OperationsOf<Group>>,
  invoker: Effect.Effect<
    OperationInvoke<OperationsOf<Group>, Failure, Services>,
    E,
    R
  >,
  outputs?: Outputs
) => {
  const server: OperationServer<
    BoundGroupOf<Group>,
    OperationsOf<Group>
  > = group;
  return server[operationServer](api, invoker, outputs);
};
