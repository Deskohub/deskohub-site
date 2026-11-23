import {
  Array as Arr,
  Effect,
  type Layer,
  Option,
  Schema,
  type Scope,
  Struct,
  type Types,
} from "effect";
import { HttpMethod, type HttpRouter } from "effect/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
} from "effect/http-api";
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
import {
  type AdministrationOperationGroup,
  administrationOperationGroup,
} from "./workspace-admin-api";

/** The names of a path's `:name` segments. */
export type PathParamNames<Path extends string> =
  Path extends `${string}:${infer Param}/${infer Rest}`
    ? Param | PathParamNames<`/${Rest}`>
    : Path extends `${string}:${infer Param}`
      ? Param
      : never;

const pathParamNamesOf = (path: string): ReadonlyArray<string> =>
  Array.from(path.matchAll(/:(\w+)/g), ([, name]) => name ?? "");

interface RouteOptions {
  /**
   * What a mutation does, for `dhw` confirmations and the AI assistant's
   * tools. A query is always a read and declares none.
   */
  readonly behavior?: AdministrationOperationBehavior["Service"];
  /**
   * The one input field the body carries, when the body isn't the rest of
   * the input.
   */
  readonly body?: string;
  /** A read carries its input beyond the path parameters as its query. */
  readonly query?: true;
}

/** Where an operation is served: its method and path, and its request's parts. */
export interface OperationRoute<
  Method extends HttpMethod.HttpMethod = HttpMethod.HttpMethod,
  Path extends HttpRouter.PathInput = HttpRouter.PathInput,
  Options extends RouteOptions = RouteOptions,
> {
  readonly method: Method;
  readonly path: Path;
  readonly options: Options;
}

type ReadOptions = Pick<RouteOptions, "behavior" | "query">;
type WriteOptions = Pick<RouteOptions, "behavior" | "body">;
type NoOptions = Record<never, never>;

interface RouteOn<
  Method extends HttpMethod.HttpMethod,
  Allowed extends RouteOptions,
> {
  <const Path extends HttpRouter.PathInput>(
    path: Path
  ): OperationRoute<Method, Path, NoOptions>;
  <const Path extends HttpRouter.PathInput, const Options extends Allowed>(
    path: Path,
    options: Options
  ): OperationRoute<Method, Path, Options>;
}

const routeOn = <
  Method extends HttpMethod.HttpMethod,
  Allowed extends RouteOptions,
>(
  method: Method
): RouteOn<Method, Allowed> => {
  function on<const Path extends HttpRouter.PathInput>(
    path: Path
  ): OperationRoute<Method, Path, NoOptions>;
  function on<
    const Path extends HttpRouter.PathInput,
    const Options extends Allowed,
  >(path: Path, options: Options): OperationRoute<Method, Path, Options>;
  function on(
    path: HttpRouter.PathInput,
    options?: Allowed
  ): OperationRoute<Method, HttpRouter.PathInput, Allowed | NoOptions> {
    return { method, path, options: options ?? {} };
  }
  return on;
};

/**
 * Routes for an operation's endpoint. Path parameters are the input fields
 * the path names. A read's other fields are absent, or its query with
 * `query: true`; a write's other fields are its body, which is absent when
 * there are none and is the whole input when the path names none.
 */
export const route = {
  get: routeOn<"GET", ReadOptions>("GET"),
  post: routeOn<"POST", WriteOptions>("POST"),
  put: routeOn<"PUT", WriteOptions>("PUT"),
  patch: routeOn<"PATCH", WriteOptions>("PATCH"),
  delete: routeOn<"DELETE", WriteOptions>("DELETE"),
} as const;

type FieldsOf<Input> =
  Input extends Schema.Struct<infer Fields extends Schema.Struct.Fields>
    ? Fields
    : Record<never, never>;
type FieldOf<
  Fields extends Schema.Struct.Fields,
  Key,
> = Key extends keyof Fields ? Fields[Key] : never;
/** `Fields` as struct fields, which TypeScript can't tell of a generic mapped type. */
type AsFields<Fields> = Extract<Fields, Schema.Struct.Fields>;
type PickFields<Fields extends Schema.Struct.Fields, Keys> = AsFields<{
  readonly [Key in Keys & keyof Fields]: Fields[Key];
}>;
type OmitFields<Fields extends Schema.Struct.Fields, Keys> = AsFields<{
  readonly [Key in keyof Fields as Key extends Keys ? never : Key]: Fields[Key];
}>;
type ParamKeysOf<Route extends OperationRoute> = PathParamNames<Route["path"]>;
type RestKeysOf<Op extends Operation, Route extends OperationRoute> = Exclude<
  keyof FieldsOf<Op["input"]> & string,
  ParamKeysOf<Route>
>;
type BodyFieldOf<Route extends OperationRoute> = Route["options"] extends {
  readonly body: infer Field extends string;
}
  ? Field
  : never;

/** The input without the path's parameters. */
type InputWithout<Input, Keys> = Schema.Struct<
  OmitFields<FieldsOf<Input>, Keys>
>;

type ParamsOf<Op extends Operation, Route extends OperationRoute> = [
  ParamKeysOf<Route>,
] extends [never]
  ? never
  : Schema.Struct<PickFields<FieldsOf<Op["input"]>, ParamKeysOf<Route>>>;

type QueryOf<
  Op extends Operation,
  Route extends OperationRoute,
> = Route["options"] extends { readonly query: true }
  ? InputWithout<Op["input"], ParamKeysOf<Route>>
  : never;

type PayloadOf<Op extends Operation, Route extends OperationRoute> = Extract<
  BodyOf<Op, Route>,
  Schema.Top
>;

type BodyOf<Op extends Operation, Route extends OperationRoute> = [
  Route["method"],
] extends [HttpMethod.HttpMethod.NoBody]
  ? never
  : [BodyFieldOf<Route>] extends [never]
    ? [RestKeysOf<Op, Route>] extends [never]
      ? never
      : [ParamKeysOf<Route>] extends [never]
        ? Op["input"]
        : InputWithout<Op["input"], ParamKeysOf<Route>>
    : FieldOf<FieldsOf<Op["input"]>, BodyFieldOf<Route>>;

/**
 * The endpoint an operation's route declares, typed as `HttpApiEndpoint`'s
 * constructors type it: its params, query and payload from the input, its
 * success from the output.
 */
export type OperationEndpoint<
  Name extends string,
  Op extends Operation,
  Route extends OperationRoute,
  Errors extends Schema.Top,
> = HttpApiEndpoint.HttpApiEndpoint<
  Name,
  Route["method"],
  Route["path"],
  StringTreeCodec<ParamsOf<Op, Route>>,
  StringTreeCodec<QueryOf<Op, Route>>,
  Route["method"] extends HttpMethod.HttpMethod.WithBody
    ? JsonCodec<PayloadOf<Op, Route>>
    : StringTreeCodec<PayloadOf<Op, Route>>,
  never,
  JsonCodec<Op["output"]>,
  JsonCodec<Errors>
>;

/** The string-tree codec `HttpApiEndpoint`'s constructors derive from a schema. */
type StringTreeCodec<S> = [S] extends [never]
  ? never
  : [S] extends [Schema.Constraint]
    ? Schema.toCodecStringTree<S>
    : never;

/** The JSON codec `HttpApiEndpoint`'s constructors derive from a schema. */
type JsonCodec<S> = [S] extends [never]
  ? never
  : [S] extends [Schema.Constraint]
    ? Schema.toCodecJson<S>
    : never;

type BehaviorProblem<
  Op extends Operation,
  Options extends RouteOptions,
> = Op["kind"] extends "query"
  ? Options extends { readonly behavior: object }
    ? "is a query, which is a read and declares no behavior"
    : never
  : Options extends { readonly behavior: infer Behavior }
    ? Behavior extends { readonly kind: "read" }
      ? "is a mutation, so its behavior isn't a read"
      : Op["ledger"] extends true
        ? Behavior extends { readonly idempotent: true }
          ? never
          : "replays a retried request, so its behavior is idempotent"
        : never
    : "is a mutation and declares its behavior";

type RequestProblem<Op extends Operation, Route extends OperationRoute> =
  | (Op["input"] extends Schema.Struct<Schema.Struct.Fields> | typeof NoInput
      ? never
      : "takes a struct input")
  | (Exclude<
      ParamKeysOf<Route>,
      keyof FieldsOf<Op["input"]>
    > extends infer Param extends string
      ? [Param] extends [never]
        ? never
        : `names :${Param} in its path, which isn't an input field`
      : never)
  | ([Route["method"]] extends [HttpMethod.HttpMethod.NoBody]
      ? Route["options"] extends { readonly query: true }
        ? [RestKeysOf<Op, Route>] extends [never]
          ? "declares a query without input beyond its path"
          : never
        : [RestKeysOf<Op, Route>] extends [never]
          ? never
          : `has no place for ${RestKeysOf<Op, Route>}; declare query: true`
      : [BodyFieldOf<Route>] extends [never]
        ? never
        : [Exclude<RestKeysOf<Op, Route>, BodyFieldOf<Route>>] extends [never]
          ? BodyFieldOf<Route> extends RestKeysOf<Op, Route>
            ? never
            : `carries ${BodyFieldOf<Route>} as its body, which isn't an input field beyond its path`
          : `has no place for ${Exclude<RestKeysOf<Op, Route>, BodyFieldOf<Route>>} beside its body`);

/** Why a route can't serve its operation, or `never` when it can. */
export type RouteProblem<Op extends Operation, Route extends OperationRoute> =
  | BehaviorProblem<Op, Route["options"]>
  | RequestProblem<Op, Route>;

/** A route for every operation; a route that can't serve one names why. */
export type OperationRoutes<Ops extends Operations> = {
  readonly [Name in keyof Ops]: OperationRoute;
};

type CheckedRoutes<
  Ops extends Operations,
  Routes extends OperationRoutes<Ops>,
> = {
  readonly [Name in keyof Routes]: Name extends keyof Ops
    ? [RouteProblem<Ops[Name], Routes[Name]>] extends [never]
      ? Routes[Name]
      : Routes[Name] & {
          readonly problem: `${Name & string} ${RouteProblem<Ops[Name], Routes[Name]>}`;
        }
    : { readonly problem: `${Name & string} is no operation` };
};

/** Every endpoint of an operation group, by its operation's name. */
export type OperationGroupEndpoints<
  Ops extends Operations,
  Routes extends OperationRoutes<Ops>,
  Errors extends Schema.Top,
> = {
  readonly [Name in keyof Ops & string]: OperationEndpoint<
    Name,
    Ops[Name],
    Routes[Name],
    Errors
  >;
}[keyof Ops & string];

const operationBinding = Symbol.for(
  "@deskohub/workspace-admin-api/OperationBinding"
);

/** The operations a group serves and the route of each. */
export interface OperationBinding<
  Ops extends Operations = Operations,
  Routes extends OperationRoutes<Ops> = OperationRoutes<Ops>,
> {
  readonly [operationBinding]: {
    readonly operations: Ops;
    readonly routes: Routes;
  };
}

/** Whether `input` is a struct, whose fields a route places in its request. */
const isStructInput = (
  input: Schema.Top
): input is Schema.Struct<Schema.Struct.Fields> =>
  "fields" in input && "mapFields" in input;

const fieldsOf = (input: Schema.Top): Schema.Struct.Fields =>
  isStructInput(input) ? input.fields : {};

/** What a route's body carries: one input field, the rest of the input, or nothing. */
type RequestBody = { readonly field: string } | "rest" | "none";

const bodyOf = (
  { method, options }: OperationRoute,
  restKeys: ReadonlyArray<string>
): RequestBody => {
  if (!HttpMethod.hasBody(method)) return "none";
  if (options.body !== undefined) return { field: options.body };
  return restKeys.length === 0 ? "none" : "rest";
};

/**
 * Where a route places its operation's input, from the input's schema: the
 * path parameters, whether the rest is the query, and what the body is.
 */
const requestLayoutOf = (
  { input }: Operation,
  operationRoute: OperationRoute
) => {
  const fields = fieldsOf(input);
  const paramKeys = pathParamNamesOf(operationRoute.path);
  const restKeys = Object.keys(fields).filter(
    (key) => !paramKeys.includes(key)
  );
  return {
    fields,
    paramKeys,
    query: operationRoute.options.query === true,
    body: bodyOf(operationRoute, restKeys),
  };
};

/** The value `body` names in `rest` or one of `fields`, or none. */
const bodyValue = <A>(
  body: RequestBody,
  rest: () => A,
  field: (name: string) => A
): A | undefined => {
  if (body === "none") return undefined;
  return body === "rest" ? rest() : field(body.field);
};

const endpointOf = (
  operation: Operation,
  operationRoute: OperationRoute,
  error: ReadonlyArray<Schema.Top>
) => {
  const { input } = operation;
  const { fields, paramKeys, query, body } = requestLayoutOf(
    operation,
    operationRoute
  );
  const rest = (): Schema.Top => {
    if (paramKeys.length === 0) return input;
    if (!isStructInput(input)) {
      throw new Error(
        `${operation.name} names path parameters without a struct input.`
      );
    }
    return input.mapFields(Struct.omit(paramKeys));
  };
  const behavior =
    operation.kind === "query"
      ? readOperation
      : operationRoute.options.behavior;
  if (behavior === undefined) {
    throw new Error(`${operation.name} is a mutation without a behavior.`);
  }
  const endpoint = HttpApiEndpoint.make(operationRoute.method)(
    operation.name,
    operationRoute.path,
    {
      params:
        paramKeys.length === 0 ? undefined : Struct.pick(fields, paramKeys),
      query: query ? rest() : undefined,
      payload: bodyValue(body, rest, (name) => {
        const field = fields[name];
        if (!Schema.isSchema(field)) {
          throw new Error(`${operation.name} has no body field ${name}.`);
        }
        return field;
      }),
      success: operation.output,
      error,
    }
  )
    // An operation's request reports every issue and refuses fields its
    // input doesn't declare.
    .annotate(HttpApi.PayloadParseOptions, administrationInputParseOptions)
    .annotate(HttpApi.QueryParseOptions, administrationInputParseOptions)
    .annotate(AdministrationOperationBehavior, behavior);
  return operation.minimumDhwVersion === undefined
    ? endpoint
    : endpoint.annotate(
        MinimumDhwVersion,
        Option.some(operation.minimumDhwVersion)
      );
};

/**
 * The `/api/v1/cli` group serving `operations`, one endpoint per operation
 * named after it. Each endpoint's request parts come from the operation's
 * input as its route places them, its success is the operation's output,
 * and it requires the operation's minimum `dhw`. A query is a read; a
 * mutation's route states its behavior. The group records each action as
 * the authenticated administrator's, refusing an outdated `dhw` before
 * reading its session. The group carries its operations and routes for
 * `operationGroupHandlers` and `operationRequest`; add it to the API as
 * returned, since `prefix`, `middleware` and `annotate` copy a group without
 * them.
 */
// `HttpApiEndpoint` types an endpoint by the schemas its constructor gets,
// and these endpoints are built from the routes at run time; the overload
// states the endpoint type `OperationGroupEndpoints` derives from the routes.
export function operationGroup<
  const Id extends string,
  Ops extends Operations,
  const Routes extends OperationRoutes<Ops>,
  const Errors extends ReadonlyArray<Schema.Top>,
>(
  identifier: Id,
  operations: Ops,
  routes: Routes & CheckedRoutes<Ops, Routes>,
  options: { readonly errors: Errors }
): OperationGroup<Id, Ops, Routes, Errors[number]>;
export function operationGroup(
  identifier: string,
  operations: Operations,
  routes: OperationRoutes<Operations>,
  { errors }: { readonly errors: ReadonlyArray<Schema.Top> }
): HttpApiGroup.Constraint & OperationBinding {
  const endpoints = Object.entries(routes).map(([name, operationRoute]) => {
    const operation = operations[name];
    if (operation === undefined) {
      throw new Error(`${identifier}.${name} routes no operation.`);
    }
    return endpointOf(operation, operationRoute, errors);
  });
  const [first, ...rest] = endpoints;
  if (first === undefined) {
    throw new Error(`${identifier} serves no operation.`);
  }
  const group = administrationOperationGroup(
    HttpApiGroup.make(identifier).add(first, ...rest),
    { checkDhwVersionBeforeAuthentication: true }
  );
  const binding: OperationBinding = {
    [operationBinding]: { operations, routes },
  };
  return Object.assign(group, binding);
}

/** The group `operationGroup` declares, carrying its operations and routes. */
export type OperationGroup<
  Id extends string,
  Ops extends Operations,
  Routes extends OperationRoutes<Ops>,
  Errors extends Schema.Top,
> = AdministrationOperationGroup<
  HttpApiGroup.HttpApiGroup<Id, OperationGroupEndpoints<Ops, Routes, Errors>>,
  { readonly checkDhwVersionBeforeAuthentication: true }
> &
  OperationBinding<Ops, Routes>;

/** Runs an operation by name; `operationGroupHandlers` serves a group with it. */
export type OperationInvoke<Ops extends Operations, Failure, Services> = <
  Name extends keyof Ops & string,
>(
  name: Name,
  input: OperationInput<Ops[Name]>
) => Effect.Effect<OperationOutput<Ops[Name]>, Failure, Services>;

/**
 * What serving `Endpoint` requires, as `HttpApiBuilder`'s `handle` adds it:
 * its middleware and their services, and the handler's own services that
 * the request doesn't provide.
 */
type ServedRequirements<Endpoint extends HttpApiEndpoint.Constraint, Services> =
  | HttpApiEndpoint.Middleware<Endpoint>
  | HttpApiEndpoint.MiddlewareServices<Endpoint>
  | (HttpApiEndpoint.ExcludeProvided<
      Endpoint,
      Services | HttpApiEndpoint.ServerServices<Endpoint>
    > extends infer Required
      ? Required extends never
        ? never
        : HttpRouter.Request<"Requires", Required>
      : never);

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

/** The request parts that carry an operation's input, as its route places them. */
const requestOf = (
  operation: Operation,
  operationRoute: OperationRoute,
  input: InputFields
): OperationRequest => {
  const { paramKeys, query, body } = requestLayoutOf(operation, operationRoute);
  const rest = Struct.omit(input, paramKeys);
  const request: Types.Mutable<OperationRequest> = {};
  if (paramKeys.length > 0) request.params = Struct.pick(input, paramKeys);
  if (query) request.query = rest;
  if (body !== "none") {
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
  const { operations, routes } = group[operationBinding];
  const operation: Operation | undefined = operations[name];
  const operationRoute: OperationRoute | undefined = routes[name];
  if (operation === undefined || operationRoute === undefined) {
    throw new Error(`${name} has no route in this group.`);
  }
  if (!Schema.is(InputFields)(input)) {
    throw new Error(`${name} takes no struct input.`);
  }
  return requestOf(operation, operationRoute, input);
};

/** The operation's input from the request parts its route placed it in. */
const inputOf = (
  { options }: OperationRoute,
  request: OperationRequest
): InputFields =>
  options.body === undefined
    ? {
        ...request.params,
        ...request.query,
        ...Schema.decodeUnknownOption(InputFields)(request.payload).pipe(
          Option.getOrElse((): InputFields => ({}))
        ),
      }
    : { ...request.params, [options.body]: request.payload };

type OperationsOf<Group extends OperationBinding> =
  Group[typeof operationBinding]["operations"];

type OutputAdapter<Output = unknown, Services = unknown> = (
  output: Output
) => Effect.Effect<Output, never, Services>;

/** Adapts some operations' outputs for the caller. */
type OutputAdapters<Ops extends Operations> = {
  readonly [Name in keyof Ops & string]?: OutputAdapter<
    OperationOutput<Ops[Name]>
  >;
};

type OutputServices<Outputs> = {
  readonly [Name in keyof Outputs]: Outputs[Name] extends (
    output: never
  ) => Effect.Effect<infer _Output, infer _Error, infer Services>
    ? Services
    : never;
}[keyof Outputs];

/** The handlers serving every endpoint of `Group`. */
type GroupHandlers<
  Group extends HttpApiGroup.Constraint,
  Services,
  Outputs,
> = HttpApiBuilder.Handlers<
  ServedRequirements<
    HttpApiGroup.Endpoints<Group>,
    Services | OutputServices<Outputs>
  >
>;

/**
 * Serves every endpoint of an operation group by running the operation of
 * its name on the input its request carries. `outputs` adapts an
 * operation's output for the caller, as withholding what an older `dhw`
 * can't decode.
 */
// `HttpApiBuilder` types each handler by an endpoint name known at compile
// time; these handlers serve the group's own routes, read at run time, so
// the overload states the layer serving every one of them.
export function operationGroupHandlers<
  ApiId extends string,
  Groups extends HttpApiGroup.Constraint,
  Group extends Groups & OperationBinding,
  Failure extends HttpApiEndpoint.Errors<HttpApiGroup.Endpoints<Group>>,
  E,
  R,
  Services,
  Outputs extends OutputAdapters<OperationsOf<Group>> = NoOptions,
>(
  api: HttpApi.HttpApi<ApiId, Groups>,
  group: Group,
  invoker: Effect.Effect<
    OperationInvoke<OperationsOf<Group>, Failure, Services>,
    E,
    R
  >,
  outputs?: Outputs
): Layer.Layer<
  HttpApiGroup.Service<ApiId, HttpApiGroup.Identifier<Group>>,
  E,
  Exclude<
    | R
    | HttpApiBuilder.Handlers.Context<GroupHandlers<Group, Services, Outputs>>,
    Scope.Scope
  >
>;
export function operationGroupHandlers(
  api: HttpApi.HttpApi<string, HttpApiGroup.Constraint>,
  group: HttpApiGroup.Constraint & OperationBinding,
  invoker: Effect.Effect<
    OperationInvoke<Operations, unknown, unknown>,
    unknown,
    unknown
  >,
  outputs?: OutputAdapters<Operations>
): Layer.Any {
  const { operations, routes } = group[operationBinding];
  const serve =
    (invoke: OperationInvoke<Operations, unknown, unknown>) =>
    ([name, operationRoute]: [string, OperationRoute]): HttpApiEndpoint.Handler<
      HttpApiEndpoint.Constraint,
      never,
      unknown
    > =>
      Effect.fnUntraced(function* (request) {
        const operation = operations[name];
        if (operation === undefined) {
          return yield* Effect.die(new Error(`${name} routes no operation.`));
        }
        const parts = yield* Effect.orDie(
          Schema.decodeUnknownEffect(OperationRequest)(request)
        );
        // The endpoint decoded each part; the port takes the encoded input
        // and decodes it again.
        const input = yield* Effect.orDie(
          Schema.encodeUnknownEffect(operation.input)(
            inputOf(operationRoute, parts)
          )
        );
        const output = invoke(name, input);
        const adapt: OutputAdapter | undefined = outputs?.[name];
        return yield* adapt === undefined
          ? output
          : Effect.flatMap(output, adapt);
      });
  return HttpApiBuilder.group(api, group.identifier, (handlers) =>
    Effect.flatMap(invoker, (invoke) => {
      // Each `handle` registers on `handlers` and returns it, so every
      // element is `handlers` serving all the routes.
      const served = Object.entries<OperationRoute>(routes).map((entry) =>
        handlers.handle(entry[0], serve(invoke)(entry))
      );
      return Arr.isReadonlyArrayNonEmpty(served)
        ? Effect.succeed(served[0])
        : Effect.die(new Error(`${group.identifier} serves no operation.`));
    })
  );
}
