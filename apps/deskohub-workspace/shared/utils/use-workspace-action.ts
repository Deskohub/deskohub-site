"use client";

import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  type HookBaseOptions,
  type SingleInputActionFn,
  type UseActionHookReturn,
  useAction,
} from "next-safe-action/hooks";
import { useRef } from "react";

// The input the action was called with, as next-safe-action types it.
type WorkspaceActionInput<
  ServerError,
  Schema extends StandardSchemaV1 | undefined,
  ShapedErrors,
  Data,
> = Parameters<
  UseActionHookReturn<ServerError, Schema, ShapedErrors, Data>["executeAsync"]
>[0];

type UseWorkspaceActionOptions<
  ServerError,
  Schema extends StandardSchemaV1 | undefined,
  ShapedErrors,
  Data,
> = HookBaseOptions<ServerError, Schema, ShapedErrors, Data> & {
  readonly onTransportError?: (args: {
    readonly error: unknown;
    readonly input: WorkspaceActionInput<
      ServerError,
      Schema,
      ShapedErrors,
      Data
    >;
  }) => void;
};

export function useWorkspaceAction<
  ServerError,
  Schema extends StandardSchemaV1 | undefined,
  ShapedErrors,
  Data,
>(
  safeActionFn: SingleInputActionFn<ServerError, Schema, ShapedErrors, Data>,
  opts: UseWorkspaceActionOptions<ServerError, Schema, ShapedErrors, Data>
): UseActionHookReturn<ServerError, Schema, ShapedErrors, Data> {
  const { onError, onTransportError, ...hookOptions } = opts;
  const action = useAction(safeActionFn, {
    ...hookOptions,
    ...(onError && {
      onError: (args: Parameters<typeof onError>[0]) => {
        // A rejected action call is already reported through onTransportError,
        // and this later callback would overwrite that transport message.
        if (onTransportError && isTransportOnlyError(args.error)) return;
        return onError(args);
      },
    }),
  });

  // The library applies only the latest call's result and callbacks, so a
  // call superseded before it settles mustn't report its transport error
  // over the newer call's outcome either.
  const latestCall = useRef(0);

  const handleTransportError = (
    cause: unknown,
    input: WorkspaceActionInput<ServerError, Schema, ShapedErrors, Data>
  ) => {
    try {
      onTransportError?.({ error: cause, input });
    } catch {}
  };

  const executeAsync = async (
    input: WorkspaceActionInput<ServerError, Schema, ShapedErrors, Data>
  ) => {
    const call = ++latestCall.current;
    try {
      return await action.executeAsync(input);
    } catch (error) {
      if (call === latestCall.current) {
        handleTransportError(error, input);
      }
      throw error;
    }
  };

  const execute = (input: Parameters<typeof action.execute>[0]) => {
    void executeAsync(input).catch(() => undefined);
  };

  const reset = () => {
    latestCall.current += 1;
    action.reset();
  };

  return {
    ...action,
    execute,
    executeAsync,
    reset,
  };
}

const isTransportOnlyError = (error: {
  readonly serverError?: unknown;
  readonly thrownError?: Error;
  readonly validationErrors?: unknown;
}) =>
  error.thrownError !== undefined &&
  error.serverError === undefined &&
  error.validationErrors === undefined;
