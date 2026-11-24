import { readFileSync } from "node:fs";
import { Schema } from "effect";

/**
 * Parses a tracked GitHub Actions workflow into typed objects so tests can
 * assert on workflow semantics (steps, run commands, permissions, env)
 * instead of pinned YAML substrings.
 */

const StringRecord = Schema.Record(Schema.String, Schema.String);

/** Step `env` and `with` values YAML may write unquoted (`fetch-depth: 0`). */
const StepValueRecord = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Number, Schema.Boolean])
);

/**
 * A YAML mapping with the keys these contracts read declared and every other
 * key kept as is, so tests still see the whole document (`strategy`, other
 * triggers) instead of a decode that silently drops it.
 */
const OpenMapping = <const Fields extends Schema.Struct.Fields>(
  fields: Fields
) =>
  Schema.StructWithRest(Schema.Struct(fields), [
    Schema.Record(Schema.String, Schema.Unknown),
  ]);

const WorkflowStep = OpenMapping({
  name: Schema.optionalKey(Schema.String),
  run: Schema.optionalKey(Schema.String),
  uses: Schema.optionalKey(Schema.String),
  id: Schema.optionalKey(Schema.String),
  if: Schema.optionalKey(Schema.String),
  "working-directory": Schema.optionalKey(Schema.String),
  "continue-on-error": Schema.optionalKey(Schema.Boolean),
  "timeout-minutes": Schema.optionalKey(Schema.Number),
  env: Schema.optionalKey(StepValueRecord),
  with: Schema.optionalKey(StepValueRecord),
  outputs: Schema.optionalKey(StringRecord),
});
export type WorkflowStep = typeof WorkflowStep.Type;

/** Cache access a job's token gets (`cache-mode`). */
const WorkflowCacheMode = Schema.Literals([
  "none",
  "read",
  "write",
  "write-only",
]);

const WorkflowConcurrency = Schema.Struct({
  group: Schema.String,
  "cancel-in-progress": Schema.optionalKey(
    Schema.Union([Schema.Boolean, Schema.String])
  ),
});

const WorkflowService = Schema.Struct({
  image: Schema.String,
  env: Schema.optionalKey(StringRecord),
  ports: Schema.optionalKey(Schema.Array(Schema.String)),
  options: Schema.optionalKey(Schema.String),
});

const WorkflowJob = OpenMapping({
  name: Schema.optionalKey(Schema.String),
  if: Schema.optionalKey(Schema.String),
  needs: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Array(Schema.String)])
  ),
  concurrency: Schema.optionalKey(WorkflowConcurrency),
  outputs: Schema.optionalKey(StringRecord),
  "cache-mode": Schema.optionalKey(WorkflowCacheMode),
  "runs-on": Schema.optionalKey(Schema.String),
  steps: Schema.optionalKey(Schema.Array(WorkflowStep)),
  /** Minutes, or an expression such as `${{ inputs.mode == ... }}`. */
  "timeout-minutes": Schema.optionalKey(
    Schema.Union([Schema.Number, Schema.String])
  ),
  permissions: Schema.optionalKey(StringRecord),
  env: Schema.optionalKey(StringRecord),
  services: Schema.optionalKey(Schema.Record(Schema.String, WorkflowService)),
});

const WorkflowDispatchInput = Schema.Struct({
  default: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.String])),
  description: Schema.optionalKey(Schema.String),
  required: Schema.optionalKey(Schema.Boolean),
  type: Schema.optionalKey(Schema.String),
});

const WorkflowDoc = OpenMapping({
  "cache-mode": Schema.optionalKey(WorkflowCacheMode),
  concurrency: Schema.optionalKey(WorkflowConcurrency),
  jobs: Schema.Record(Schema.String, WorkflowJob),
  on: Schema.optionalKey(
    OpenMapping({
      schedule: Schema.optionalKey(
        Schema.Array(Schema.Struct({ cron: Schema.String }))
      ),
      workflow_dispatch: Schema.optionalKey(
        Schema.NullOr(
          Schema.Struct({
            inputs: Schema.optionalKey(
              Schema.Record(Schema.String, WorkflowDispatchInput)
            ),
          })
        )
      ),
    })
  ),
  permissions: Schema.optionalKey(StringRecord),
});
export type WorkflowDoc = typeof WorkflowDoc.Type;

const decodeWorkflow = Schema.decodeUnknownSync(WorkflowDoc);

export const parseWorkflow = (path: string): WorkflowDoc =>
  decodeWorkflow(Bun.YAML.parse(readFileSync(path, "utf8")));

/** A tracked composite action (`.github/actions/<name>/action.yml`). */
const CompositeActionDoc = OpenMapping({
  inputs: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        required: Schema.optionalKey(Schema.Boolean),
        default: Schema.optionalKey(Schema.String),
      })
    )
  ),
  outputs: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Struct({ value: Schema.String }))
  ),
  runs: OpenMapping({
    using: Schema.String,
    steps: Schema.Array(WorkflowStep),
  }),
});
export type CompositeActionDoc = typeof CompositeActionDoc.Type;

const decodeCompositeAction = Schema.decodeUnknownSync(CompositeActionDoc);

export const parseCompositeAction = (path: string): CompositeActionDoc =>
  decodeCompositeAction(Bun.YAML.parse(readFileSync(path, "utf8")));

export const workflowJobs = (doc: WorkflowDoc): readonly string[] =>
  Object.keys(doc.jobs);

export const workflowSteps = (
  doc: WorkflowDoc,
  jobId: string
): readonly WorkflowStep[] => doc.jobs[jobId]?.steps ?? [];

export const workflowStepNames = (doc: WorkflowDoc): readonly string[] =>
  Object.values(doc.jobs).flatMap((job) =>
    (job.steps ?? [])
      .map((step) => step.name ?? "")
      .filter((name) => name.length > 0)
  );

export const workflowStepRuns = (doc: WorkflowDoc): readonly string[] =>
  Object.values(doc.jobs).flatMap((job) =>
    (job.steps ?? [])
      .map((step) => step.run ?? "")
      .filter((run) => run.length > 0)
  );

export const findStepByName = (
  doc: WorkflowDoc,
  name: string
): WorkflowStep | undefined =>
  Object.values(doc.jobs)
    .flatMap((job) => job.steps ?? [])
    .find((step) => step.name === name);

type WorkflowExpressionValue =
  | { readonly kind: "null" }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "string"; readonly value: string };

export interface WorkflowExpressionContext {
  /**
   * Contexts the caller models, such as `inputs`. A missing property of one
   * reads as null, as on GitHub; a path under any other context throws.
   */
  readonly contexts: readonly string[];
  /** Values keyed by their full path, such as `inputs.sha`. */
  readonly values: ReadonlyMap<string, WorkflowExpressionValue>;
}

type WorkflowExpressionToken =
  | { readonly kind: "operator"; readonly value: string }
  | { readonly kind: "path"; readonly value: string }
  | { readonly kind: "string"; readonly value: string };

export const workflowExpressionString = (
  value: string
): WorkflowExpressionValue => ({ kind: "string", value });

export const workflowExpressionBoolean = (
  value: boolean
): WorkflowExpressionValue => ({ kind: "boolean", value });

const expressionToken =
  /\s*(?:(==|!=|&&|\|\|)|'((?:[^']|'')*)'|([A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*))/y;

const tokenizeExpression = (
  source: string
): readonly WorkflowExpressionToken[] => {
  const tokens: WorkflowExpressionToken[] = [];
  expressionToken.lastIndex = 0;
  while (source.slice(expressionToken.lastIndex).trim() !== "") {
    const match = expressionToken.exec(source);
    if (match === null) {
      throw new Error(`unsupported workflow expression syntax: ${source}`);
    }
    const [, operator, text, path] = match;
    if (operator !== undefined) {
      tokens.push({ kind: "operator", value: operator });
    } else if (text !== undefined) {
      tokens.push({ kind: "string", value: text.replaceAll("''", "'") });
    } else if (path !== undefined) {
      tokens.push({ kind: "path", value: path });
    } else {
      throw new Error(`unsupported workflow expression syntax: ${source}`);
    }
  }
  return tokens;
};

const expressionTruthy = (value: WorkflowExpressionValue) =>
  value.kind === "boolean"
    ? value.value
    : value.kind === "string" && value.value !== "";

const expressionEqual = (
  left: WorkflowExpressionValue,
  right: WorkflowExpressionValue
) => {
  if (left.kind === "string" && right.kind === "string") {
    return left.value.toLowerCase() === right.value.toLowerCase();
  }
  if (left.kind === "boolean" && right.kind === "boolean") {
    return left.value === right.value;
  }
  if (left.kind === "null" && right.kind === "null") {
    return true;
  }
  throw new Error("unsupported mixed-type workflow expression comparison");
};

const resolveExpressionPath = (
  context: WorkflowExpressionContext,
  path: string
): WorkflowExpressionValue => {
  if (!context.contexts.some((root) => path.startsWith(`${root}.`))) {
    throw new Error(`unsupported workflow expression context: ${path}`);
  }
  return context.values.get(path) ?? { kind: "null" };
};

// Evaluates the GitHub Actions expression subset of context paths, string
// literals, ==, !=, && and ||, with GitHub's precedence and operand-returning &&
// and ||. It evaluates both operands where GitHub short-circuits, and anything
// outside the subset throws, so an expression it cannot model fails instead
// of misevaluating.
const evaluateExpression = (
  source: string,
  context: WorkflowExpressionContext
): WorkflowExpressionValue => {
  const tokens = tokenizeExpression(source);
  let position = 0;
  const accept = (operator: string) => {
    const token = tokens[position];
    if (token?.kind !== "operator" || token.value !== operator) {
      return false;
    }
    position += 1;
    return true;
  };
  const operand = (): WorkflowExpressionValue => {
    const token = tokens[position];
    position += 1;
    if (token?.kind === "string") {
      return workflowExpressionString(token.value);
    }
    if (token?.kind === "path") {
      return resolveExpressionPath(context, token.value);
    }
    throw new Error(`unsupported workflow expression: ${source}`);
  };
  const equality = (): WorkflowExpressionValue => {
    const left = operand();
    if (accept("==")) {
      return workflowExpressionBoolean(expressionEqual(left, operand()));
    }
    if (accept("!=")) {
      return workflowExpressionBoolean(!expressionEqual(left, operand()));
    }
    return left;
  };
  const and = (): WorkflowExpressionValue => {
    let value = equality();
    while (accept("&&")) {
      const right = equality();
      value = expressionTruthy(value) ? right : value;
    }
    return value;
  };
  const or = (): WorkflowExpressionValue => {
    let value = and();
    while (accept("||")) {
      const right = and();
      value = expressionTruthy(value) ? value : right;
    }
    return value;
  };
  const value = or();
  if (position !== tokens.length) {
    throw new Error(`unsupported workflow expression: ${source}`);
  }
  return value;
};

/**
 * Resolves a workflow value that is a single `${{ }}` expression to the
 * string GitHub hands the step, so tests can assert what a workflow does for
 * a given event instead of pinning its expression text.
 */
export const evaluateWorkflowValue = (
  value: string,
  context: WorkflowExpressionContext
): string => {
  const expression = /^\$\{\{(.*)\}\}$/s.exec(value.trim());
  if (expression === null) {
    throw new Error(`expected a single workflow expression: ${value}`);
  }
  const result = evaluateExpression(expression[1] ?? "", context);
  if (result.kind === "null") {
    return "";
  }
  return String(result.value);
};
