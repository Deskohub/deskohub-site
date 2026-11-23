import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type { ImageDigest, WorkspaceWorkload } from "../config/stack-config";
import type { ObservedService } from "../readback";

/** The live platform could not be read, so nothing about it is known. */
export class ReleaseReadbackUnavailable extends Data.TaggedError(
  "ReleaseReadbackUnavailable"
)<{
  /** The Cloud Run resource name that was read. */
  readonly resource: string;
  /** The HTTP status, or null when no response arrived. */
  readonly status: number | null;
  readonly reason: string;
}> {}

/** One Cloud Run revision as the platform reports it. */
export interface ObservedRevision {
  readonly revision: string;
  /** The digest Cloud Run resolved for the serving container, if any. */
  readonly imageDigest: ImageDigest | null;
  /** The revision's Ready condition succeeded. */
  readonly ready: boolean;
}

/**
 * Independent readback of the release-owned Cloud Run services. It reads
 * the live platform, never the apply tool's own result, so a stale or
 * interrupted apply shows up as drift instead of passing.
 */
export class ReleaseServiceReadback extends Context.Service<
  ReleaseServiceReadback,
  {
    /** The live service of one workload, or null while it does not exist. */
    readonly service: (
      workload: WorkspaceWorkload
    ) => Effect.Effect<ObservedService | null, ReleaseReadbackUnavailable>;
    /** One web service revision, or null when Cloud Run has none by that name. */
    readonly revision: (
      revision: string
    ) => Effect.Effect<ObservedRevision | null, ReleaseReadbackUnavailable>;
  }
>()("@deskohub/workspace-infrastructure/ReleaseServiceReadback") {}

/** The service apply did not finish; whether any of it landed is unknown. */
export class ReleaseServiceApplyFailed extends Data.TaggedError(
  "ReleaseServiceApplyFailed"
)<{
  readonly generation: number;
  readonly reason: string;
}> {}

/**
 * Applies the release-owned services declared from the release record at
 * exactly `generation`. The apply refuses a record at any other generation,
 * and applying the same generation again is idempotent.
 */
export class ReleaseServiceApply extends Context.Service<
  ReleaseServiceApply,
  {
    readonly apply: (
      generation: number
    ) => Effect.Effect<void, ReleaseServiceApplyFailed>;
  }
>()("@deskohub/workspace-infrastructure/ReleaseServiceApply") {}
