/**
 * Who owns each piece of the Workspace Google Cloud surface (#1452). One
 * owner per workload or field: Alchemy beta.87 for what its GCP provider
 * declares, Terraform (`infra/workspace-edge`) for the unsupported edge
 * subgraph, the owner bootstrap for identity and state, and deferred items
 * with the reason they wait.
 */
export type SurfaceOwner =
  | {
      readonly kind: "alchemy";
      /** The beta.87 resource type that declares it. */
      readonly resourceType: string;
    }
  | { readonly kind: "terraform"; readonly path: string }
  | { readonly kind: "owner-bootstrap"; readonly path: string }
  | { readonly kind: "deferred"; readonly reason: string };

export interface SurfaceItem {
  readonly capability: string;
  readonly owner: SurfaceOwner;
}

const alchemy = (resourceType: string) =>
  ({ kind: "alchemy", resourceType }) as const;
const edge = { kind: "terraform", path: "infra/workspace-edge" } as const;
const bootstrap = {
  kind: "owner-bootstrap",
  path: "packages/workspace-infrastructure/scripts/bootstrap-sandbox-wif.sh",
} as const;

export const workspaceSurfaceClassification: ReadonlyArray<SurfaceItem> = [
  {
    capability: "Artifact Registry image repository",
    owner: alchemy("GCP.ArtifactRegistry.Repository"),
  },
  {
    capability: "Cloud Run web service, revision and traffic",
    owner: alchemy("GCP.Run.Service"),
  },
  {
    capability: "Cloud Run private tasks and scheduler workers",
    owner: alchemy("GCP.Run.Service"),
  },
  {
    capability: "Worker invoker and secret accessor IAM edges",
    owner: alchemy("GCP.IAM.Member"),
  },
  {
    capability: "Cloud Tasks queues",
    owner: alchemy("GCP.CloudTasks.Queue"),
  },
  {
    capability: "Cloud Scheduler jobs",
    owner: alchemy("GCP.CloudScheduler.Job"),
  },
  {
    capability: "Mobile updates bucket",
    owner: alchemy("GCP.Storage.Bucket"),
  },
  {
    capability: "Cloud Monitoring alert policies",
    owner: alchemy("GCP.Monitoring.AlertPolicy"),
  },
  {
    capability: "External HTTPS load balancer and serverless NEG",
    owner: edge,
  },
  { capability: "Cloud Armor security policy", owner: edge },
  { capability: "Cloud CDN policy", owner: edge },
  {
    capability: "Log Router exclusions for token-bearing routes",
    owner: edge,
  },
  {
    capability: "Workload identity pool, provider and service accounts",
    owner: bootstrap,
  },
  { capability: "Versioned Alchemy state bucket", owner: bootstrap },
  {
    capability: "Secret Manager secrets and versions",
    owner: {
      kind: "deferred",
      reason:
        "Values are entered by their owners in Secret Manager; the stack only references pinned versions and grants access.",
    },
  },
  {
    capability: "Mobile updates bucket retention lock",
    owner: {
      kind: "deferred",
      reason:
        "beta.87 Storage.Bucket has no retention or object-lock props; decide the owner before production mobile delivery.",
    },
  },
  {
    capability: "Release record store",
    owner: {
      kind: "deferred",
      reason:
        "The reconciler runs against the ReleaseRecordStore port; the Cloud Storage adapter with generation preconditions ships with the hosted #1452 proof.",
    },
  },
  {
    capability: "Project billing budget",
    owner: {
      kind: "deferred",
      reason:
        "Billing-account permissions stay with the billing owner; the sandbox records approved spend and teardown in its stack config.",
    },
  },
];
