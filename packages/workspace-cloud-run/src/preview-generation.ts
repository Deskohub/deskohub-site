import * as Schema from "effect/Schema";
import { sha256Hex } from "./sha256";

export const backendRevisionHeader = "x-deskohub-backend-revision";
export const previewGenerationHeader = "x-deskohub-preview-generation";
export const cloudRunRevisionHeader = "x-deskohub-cloud-run-revision";

export const PreviewCommitSha = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{40}$/)
);
export const PreviewDeploymentId = Schema.String.check(
  Schema.isPattern(/^dpl_[A-Za-z0-9]{1,64}$/)
);
export const PreviewNeonBranchId = Schema.String.check(
  Schema.isPattern(/^br-[a-z0-9-]{1,60}$/)
);

export const previewBackendBranchTag = (branch: string) =>
  `b-${sha256Hex(branch).slice(0, 12)}`;

/** Use the Cloud Run service origin as the audience for all of its tags. */
export const taggedCloudRunOrigin = (serviceOrigin: string, tag: string) => {
  const url = URL.parse(serviceOrigin);
  if (
    url?.origin !== serviceOrigin ||
    url.protocol !== "https:" ||
    url.port ||
    !/^[a-z0-9.-]+\.run\.app$/.test(url.hostname) ||
    url.hostname.includes("---") ||
    !/^[a-z][a-z0-9-]{0,24}$/.test(tag)
  ) {
    return undefined;
  }
  return `https://${tag}---${url.hostname}`;
};

/** Comparison key for direct and pooled URLs on the same Neon endpoint. */
export const previewDatabaseEndpoint = (connectionString: string) => {
  const url = URL.parse(connectionString);
  if (
    !url ||
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(url.hostname) ||
    !/^\/[^/]+$/.test(url.pathname)
  ) {
    return undefined;
  }
  const endpoint = url.hostname.replace(/-pooler\./, ".");
  return sha256Hex(`${endpoint}${url.pathname}`);
};

export const PreviewRuntimeBinding = Schema.Struct({
  commitSha: PreviewCommitSha,
  deploymentId: PreviewDeploymentId,
  branchTag: Schema.String.check(Schema.isPattern(/^(b-[0-9a-f]{12}|main)$/)),
  databaseEndpoint: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
});
export type PreviewRuntimeBinding = typeof PreviewRuntimeBinding.Type;

/** Contains no credential or provider endpoint. Compare before accepting RPC. */
export const previewRuntimeGeneration = (binding: PreviewRuntimeBinding) =>
  sha256Hex(
    JSON.stringify([
      binding.commitSha,
      binding.deploymentId,
      binding.branchTag,
      binding.databaseEndpoint,
    ])
  );
