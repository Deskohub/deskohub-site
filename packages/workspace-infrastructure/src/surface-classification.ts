/**
 * Who owns each piece of the Workspace Google Cloud surface (#1452). One
 * owner per workload or field: Alchemy for everything the stack declares,
 * through a beta.87 GCP resource or, where beta.87 cannot send a field, a
 * resource of this package; the owner bootstrap for identity and state, the
 * release flow for the release record in the state bucket, and deferred
 * items with the reason they wait.
 */
export type SurfaceOwner =
  | {
      readonly kind: "alchemy";
      /** The beta.87 or package resource type that declares it. */
      readonly resourceType: string;
    }
  | { readonly kind: "owner-bootstrap"; readonly path: string }
  /** The fenced release flow that owns the record and drives service apply. */
  | { readonly kind: "release-flow"; readonly path: string }
  | { readonly kind: "deferred"; readonly reason: string };

export interface SurfaceItem {
  readonly capability: string;
  readonly owner: SurfaceOwner;
}

const alchemy = (resourceType: string) =>
  ({ kind: "alchemy", resourceType }) as const;
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
    capability: "Edge global IP address",
    owner: alchemy("GCP.Compute.GlobalAddress"),
  },
  {
    capability: "Serverless NEG for the web service",
    owner: alchemy("GCP.Compute.RegionNetworkEndpointGroup"),
  },
  {
    capability: "Cloud Armor security policy",
    owner: alchemy("GCP.Compute.SecurityPolicy"),
  },
  {
    capability:
      "Edge backend services, Cloud CDN policy and Cloud Armor attachment",
    owner: alchemy("DeskohubWorkspace.EdgeBackendService"),
  },
  {
    capability: "Edge and HTTPS redirect URL maps",
    owner: alchemy("GCP.Compute.UrlMap"),
  },
  {
    capability: "Edge managed certificate",
    owner: alchemy("GCP.Compute.SslCertificate"),
  },
  {
    capability: "Edge HTTPS proxy",
    owner: alchemy("GCP.Compute.TargetHttpsProxy"),
  },
  {
    capability: "Edge HTTP redirect and plain HTTP proxies",
    owner: alchemy("GCP.Compute.TargetHttpProxy"),
  },
  {
    capability: "Edge forwarding rules",
    owner: alchemy("GCP.Compute.GlobalForwardingRule"),
  },
  {
    capability: "Log Router exclusions for token-bearing routes",
    owner: alchemy("GCP.Logging.Exclusion"),
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
    capability: "Release record and fenced service apply",
    owner: {
      kind: "release-flow",
      path: "packages/workspace-infrastructure/src/release",
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
