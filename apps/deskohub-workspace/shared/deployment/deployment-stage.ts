import { Schema } from "effect";

/**
 * The stage a Workspace deployment serves: `production`, a `preview` of a
 * branch, or local `development`. Preview stays distinct from development:
 * previews run deployed infrastructure with synthetic data.
 */
export const deploymentStageSchema = Schema.Literals([
  "production",
  "preview",
  "development",
]);

export type DeploymentStage = typeof deploymentStageSchema.Type;

/** The stage name configuration helpers have always used. */
export type DeploymentEnvironment = DeploymentStage;

/**
 * The raw stage setting of a host: `WORKSPACE_DEPLOYMENT_STAGE` where the
 * host sets it, such as a Cloud Run revision, else Vercel's `VERCEL_ENV`.
 * Validation of the value stays with the environment schema.
 */
export const selectDeploymentStageSetting = (environment: {
  readonly WORKSPACE_DEPLOYMENT_STAGE?: string | undefined;
  readonly VERCEL_ENV?: string | undefined;
}): string | undefined =>
  environment.WORKSPACE_DEPLOYMENT_STAGE || environment.VERCEL_ENV;

/**
 * Selects the production value on a production deployment and the
 * `otherwise` value on every other deployment, including one whose stage is
 * missing.
 */
export const byStage = <A>(
  deploymentStage: DeploymentStage,
  choices: { readonly production: A; readonly otherwise: A }
): A =>
  deploymentStage === "production" ? choices.production : choices.otherwise;
