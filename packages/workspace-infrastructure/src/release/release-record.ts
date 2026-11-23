import * as Schema from "effect/Schema";
import { ImageDigest } from "../config/stack-config";

/**
 * How long a demoted deployment stays routable for pages it already served:
 * the Next asset and Server Action skew window (#1458).
 */
export const compatibleDeploymentWindowHours = 12;

export const ReleaseId = Schema.String.check(
  Schema.isPattern(/^r[0-9]{1,9}-[0-9a-f]{7}$/)
).pipe(
  Schema.brand("ReleaseId"),
  Schema.annotate({
    identifier: "ReleaseId",
    description:
      "A release: the generation that staged it and the short commit SHA.",
  })
);
export type ReleaseId = typeof ReleaseId.Type;

export const GitSha = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{40}$/)
).pipe(
  Schema.brand("GitSha"),
  Schema.annotate({ identifier: "GitSha", description: "A full commit SHA." })
);
export type GitSha = typeof GitSha.Type;

/**
 * Where a release serves from. Only Cloud Run is verifiable from revision
 * and digest readback; the Vercel bridge (#1458) joins when it has its own
 * readback.
 */
export const ReleaseOrigin = Schema.Literals(["cloud-run"]);
export type ReleaseOrigin = typeof ReleaseOrigin.Type;

const Instant = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/)
);

export const ReleaseDeployment = Schema.Struct({
  releaseId: ReleaseId,
  sha: GitSha,
  imageDigest: ImageDigest,
  origin: ReleaseOrigin,
  /** The Cloud Run revision name the release creates. */
  revision: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,62}$/)),
}).annotate({ identifier: "ReleaseDeployment" });
export type ReleaseDeployment = typeof ReleaseDeployment.Type;

export const VerifiedDeployment = Schema.Struct({
  ...ReleaseDeployment.fields,
  /** When traffic readback confirmed the release served. */
  verifiedAt: Instant,
}).annotate({ identifier: "VerifiedDeployment" });
export type VerifiedDeployment = typeof VerifiedDeployment.Type;

export const CompatibleDeployment = Schema.Struct({
  ...VerifiedDeployment.fields,
  /** End of the window in which already-open pages may still reach it. */
  expiresAt: Instant,
}).annotate({ identifier: "CompatibleDeployment" });
export type CompatibleDeployment = typeof CompatibleDeployment.Type;

/**
 * A traffic change persisted before it is applied. If the run dies, the
 * next reconciler finds it and settles it from readback.
 */
export const PendingApply = Schema.Struct({
  operation: Schema.Literals(["promote", "restore"]),
  target: ReleaseDeployment,
  startedAt: Instant,
}).annotate({ identifier: "PendingApply" });
export type PendingApply = typeof PendingApply.Type;

/**
 * The authoritative Workspace release record. It lives outside the CI run
 * and every change advances `generation`, so a run holding an older
 * generation cannot overwrite a newer decision.
 */
export const ReleaseRecord = Schema.Struct({
  generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  active: Schema.NullOr(VerifiedDeployment),
  previous: Schema.NullOr(VerifiedDeployment),
  /**
   * The one staged release. Once a release is active, the web service
   * materializes the candidate as a zero-traffic revision for verification.
   */
  candidate: Schema.NullOr(ReleaseDeployment),
  compatible: Schema.Array(CompatibleDeployment),
  pendingApply: Schema.NullOr(PendingApply),
}).annotate({ identifier: "ReleaseRecord" });
export type ReleaseRecord = typeof ReleaseRecord.Type;

export const emptyReleaseRecord: ReleaseRecord = {
  generation: 0,
  active: null,
  previous: null,
  candidate: null,
  compatible: [],
  pendingApply: null,
};
