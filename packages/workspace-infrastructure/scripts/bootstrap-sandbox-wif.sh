#!/usr/bin/env bash
# Owner-operated bootstrap for the Workspace Google Cloud sandbox (#1452).
#
# Run it in an authorized Cloud Shell for the sandbox project. It enables
# the APIs the first deployment needs, records approved spend and teardown
# on the project, creates the deploy, runtime and invoker service accounts,
# trusts GitHub Actions only for the protected sandbox environment of the
# trusted workflow, creates the versioned state bucket, and prints the
# `gh variable set` commands for the repository maintainer. It never reads,
# writes or prints a secret value. Rerunning it is safe and converges.
#
# It runs in two phases. The first grants the deploy identity only the
# read access the smoke workflow needs. After the smoke workflow passes and
# a run outside the trusted workflow or environment is confirmed denied,
# rerun with --grant-deploy-roles to grant deployment permissions.
#
# Usage:
#   bootstrap-sandbox-wif.sh \
#     --project-id <id> --github-repository <owner>/<name> \
#     --github-owner-id <numeric id> --github-repository-id <numeric id> \
#     --max-spend <amount> --currency <ISO 4217> --teardown-date <YYYY-MM-DD> \
#     [--region europe-west1] [--project-number <number>] \
#     [--grant-deploy-roles] [--managed-secret <secret id>]... [--dry-run]
#
# Numeric GitHub IDs: gh api repos/<owner>/<name> --jq '.owner.id, .id'
# --dry-run prints every command instead of running it.
set -euo pipefail

region="europe-west1"
environment_name="workspace-gcp-sandbox"
trusted_workflow_path=".github/workflows/workspace-gcp-sandbox-smoke.yml"
trusted_ref="refs/heads/main"
# A pool dedicated to this one provider, so no other provider can map to
# the same subject.
pool_id="workspace-sandbox-github"
provider_id="deskohub-workspace"
dry_run=false
grant_deploy_roles=false
managed_secrets=()
project_id=""
project_number=""
github_repository=""
github_owner_id=""
github_repository_id=""
max_spend=""
currency=""
teardown_date=""

usage() {
  sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

fail() {
  echo "bootstrap-sandbox-wif: $*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-id) project_id="${2:-}"; shift 2 ;;
    --project-number) project_number="${2:-}"; shift 2 ;;
    --region) region="${2:-}"; shift 2 ;;
    --github-repository) github_repository="${2:-}"; shift 2 ;;
    --github-owner-id) github_owner_id="${2:-}"; shift 2 ;;
    --github-repository-id) github_repository_id="${2:-}"; shift 2 ;;
    --max-spend) max_spend="${2:-}"; shift 2 ;;
    --currency) currency="${2:-}"; shift 2 ;;
    --teardown-date) teardown_date="${2:-}"; shift 2 ;;
    --grant-deploy-roles) grant_deploy_roles=true; shift ;;
    --managed-secret) managed_secrets+=("${2:-}"); shift 2 ;;
    --dry-run) dry_run=true; shift ;;
    -h | --help) usage ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[[ "$project_id" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || fail "--project-id must be a Google Cloud project ID"
[[ "$region" =~ ^[a-z]+-[a-z]+[0-9]$ ]] || fail "--region must be a Google Cloud region"
[[ "$github_repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "--github-repository must be <owner>/<name>"
[[ "$github_owner_id" =~ ^[1-9][0-9]*$ ]] || fail "--github-owner-id must be the numeric owner ID"
[[ "$github_repository_id" =~ ^[1-9][0-9]*$ ]] || fail "--github-repository-id must be the numeric repository ID"
[[ "$max_spend" =~ ^[1-9][0-9]*$ ]] || fail "--max-spend must be a whole amount"
[[ "$currency" =~ ^[A-Z]{3}$ ]] || fail "--currency must be an ISO 4217 code"
[[ "$teardown_date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || fail "--teardown-date must be YYYY-MM-DD"
for secret_id in "${managed_secrets[@]}"; do
  [[ "$secret_id" =~ ^[A-Za-z0-9_-]{1,255}$ ]] || fail "--managed-secret must be a Secret Manager secret ID"
done
if [[ -n "$project_number" && ! "$project_number" =~ ^[1-9][0-9]{5,19}$ ]]; then
  fail "--project-number must be numeric"
fi

run() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
  if [[ "$dry_run" == false ]]; then
    "$@"
  fi
}

# True when the described resource already exists. Dry runs assume it
# does not, so they print every create.
exists() {
  [[ "$dry_run" == false ]] && "$@" >/dev/null 2>&1
}

# Live runs always resolve the number from the approved project ID, before
# any change, so a mistyped --project-number never grants another
# project's service agents access here.
if [[ "$dry_run" == false ]]; then
  resolved_number="$(gcloud projects describe "$project_id" --format='value(projectNumber)')"
  [[ "$resolved_number" =~ ^[1-9][0-9]{5,19}$ ]] || fail "could not resolve the number of $project_id"
  if [[ -n "$project_number" && "$project_number" != "$resolved_number" ]]; then
    fail "--project-number does not belong to $project_id"
  fi
  project_number="$resolved_number"
elif [[ -z "$project_number" ]]; then
  project_number="000000000000"
fi

if [[ "$dry_run" == false ]]; then
  billing_enabled="$(gcloud billing projects describe "$project_id" --format='value(billingEnabled)')"
  [[ "$billing_enabled" == "True" ]] || fail "billing is not enabled on $project_id; link the approved billing account first"
fi

sa_email() { echo "$1@${project_id}.iam.gserviceaccount.com"; }
deployer="$(sa_email workspace-deployer)"
runtime_accounts=(workspace-web workspace-tasks-worker workspace-scheduler-worker)
invoker_accounts=(workspace-tasks-invoker workspace-scheduler-invoker)
publisher_account=workspace-mobile-publisher
state_bucket="${project_id}-workspace-state"
pool_name="projects/${project_number}/locations/global/workloadIdentityPools/${pool_id}"
provider_name="${pool_name}/providers/${provider_id}"
trusted_workflow_ref="${github_repository}/${trusted_workflow_path}@${trusted_ref}"
trusted_subject="repo:${github_repository}:environment:${environment_name}"

echo "== APIs"
run gcloud services enable --project "$project_id" \
  artifactregistry.googleapis.com cloudbilling.googleapis.com \
  cloudresourcemanager.googleapis.com cloudscheduler.googleapis.com \
  cloudtasks.googleapis.com compute.googleapis.com iam.googleapis.com \
  iamcredentials.googleapis.com logging.googleapis.com \
  monitoring.googleapis.com run.googleapis.com secretmanager.googleapis.com \
  storage.googleapis.com sts.googleapis.com

echo "== Approved spend and teardown"
spend_label="$(echo "${max_spend}-${currency}" | tr '[:upper:]' '[:lower:]')"
run gcloud projects update "$project_id" \
  --update-labels "workspace-sandbox-max-spend=${spend_label},workspace-sandbox-teardown=${teardown_date}"

echo "== Service accounts"
for account in workspace-deployer "${runtime_accounts[@]}" "${invoker_accounts[@]}" "$publisher_account"; do
  exists gcloud iam service-accounts describe "$(sa_email "$account")" --project "$project_id" ||
    run gcloud iam service-accounts create "$account" --project "$project_id" \
    --display-name "Workspace ${account#workspace-}"
done

echo "== Runtime accounts may enqueue Cloud Tasks as the tasks invoker"
for account in "${runtime_accounts[@]}"; do
  run gcloud projects add-iam-policy-binding "$project_id" --condition=None --quiet \
    --member "serviceAccount:$(sa_email "$account")" --role roles/cloudtasks.enqueuer --format=none
  run gcloud iam service-accounts add-iam-policy-binding "$(sa_email workspace-tasks-invoker)" \
    --project "$project_id" --member "serviceAccount:$(sa_email "$account")" \
    --role roles/iam.serviceAccountUser --format=none
done

echo "== Google service agents may act as and mint OIDC tokens for their invokers"
# Cloud Tasks and Cloud Scheduler sign each request as the invoker account.
# Their service agents need Service Account Token Creator on it, and Cloud
# Tasks' primary agent also needs Service Account User (actAs).
run gcloud beta services identity create --service cloudtasks.googleapis.com --project "$project_id" --format=none
run gcloud beta services identity create --service cloudscheduler.googleapis.com --project "$project_id" --format=none
run gcloud iam service-accounts add-iam-policy-binding "$(sa_email workspace-tasks-invoker)" \
  --project "$project_id" --role roles/iam.serviceAccountTokenCreator --format=none \
  --member "serviceAccount:service-${project_number}@gcp-sa-cloudtasks.iam.gserviceaccount.com"
run gcloud iam service-accounts add-iam-policy-binding "$(sa_email workspace-tasks-invoker)" \
  --project "$project_id" --role roles/iam.serviceAccountUser --format=none \
  --member "serviceAccount:service-${project_number}@gcp-sa-cloudtasks.iam.gserviceaccount.com"
run gcloud iam service-accounts add-iam-policy-binding "$(sa_email workspace-scheduler-invoker)" \
  --project "$project_id" --role roles/iam.serviceAccountTokenCreator --format=none \
  --member "serviceAccount:service-${project_number}@gcp-sa-cloudscheduler.iam.gserviceaccount.com"

echo "== Workload identity federation"
exists gcloud iam workload-identity-pools describe "$pool_id" --project "$project_id" --location global ||
  run gcloud iam workload-identity-pools create "$pool_id" --project "$project_id" --location global \
  --display-name "GitHub Actions"
attribute_mapping="google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id,attribute.environment=assertion.environment,attribute.workflow_ref=assertion.workflow_ref"
attribute_condition="assertion.repository_owner_id == '${github_owner_id}' && assertion.repository_id == '${github_repository_id}' && assertion.environment == '${environment_name}' && assertion.workflow_ref == '${trusted_workflow_ref}'"
exists gcloud iam workload-identity-pools providers describe "$provider_id" \
  --project "$project_id" --location global --workload-identity-pool "$pool_id" ||
  run gcloud iam workload-identity-pools providers create-oidc "$provider_id" \
  --project "$project_id" --location global --workload-identity-pool "$pool_id" \
  --display-name "Deskohub Workspace sandbox" \
  --issuer-uri "https://token.actions.githubusercontent.com" \
  --attribute-mapping "$attribute_mapping" \
  --attribute-condition "$attribute_condition"
# Converge issuer, mapping and condition on reruns.
run gcloud iam workload-identity-pools providers update-oidc "$provider_id" \
  --project "$project_id" --location global --workload-identity-pool "$pool_id" \
  --issuer-uri "https://token.actions.githubusercontent.com" \
  --attribute-mapping "$attribute_mapping" \
  --attribute-condition "$attribute_condition"
# Grant by subject only when this provider is the pool's sole provider.
if [[ "$dry_run" == false ]]; then
  providers="$(gcloud iam workload-identity-pools providers list --project "$project_id" \
    --location global --workload-identity-pool "$pool_id" --format='value(name)')"
  [[ "$providers" == "$provider_name" ]] ||
    fail "pool $pool_id must contain only provider $provider_id before deploy access is granted"
  # Uploaded signing keys would replace GitHub's published keys as the
  # trust root; accept only keys discovered from the issuer.
  provider_field() {
    gcloud iam workload-identity-pools providers describe "$provider_id" \
      --project "$project_id" --location global --workload-identity-pool "$pool_id" \
      --format="value($1)"
  }
  # Checked assignments: a failed read must stop here, never look empty.
  issuer_uri="$(provider_field oidc.issuerUri)" ||
    fail "could not read the issuer of provider $provider_id"
  jwks_json="$(provider_field oidc.jwksJson)" ||
    fail "could not read the signing keys of provider $provider_id"
  [[ "$issuer_uri" == "https://token.actions.githubusercontent.com" ]] ||
    fail "provider $provider_id must use GitHub's issuer"
  [[ -z "$jwks_json" ]] ||
    fail "provider $provider_id has uploaded signing keys; remove them so GitHub's published keys are the trust root"
fi
run gcloud iam service-accounts add-iam-policy-binding "$deployer" --project "$project_id" \
  --role roles/iam.workloadIdentityUser --format=none \
  --member "principal://iam.googleapis.com/${pool_name}/subject/${trusted_subject}"

echo "== Versioned state bucket"
exists gcloud storage buckets describe "gs://${state_bucket}" ||
  run gcloud storage buckets create "gs://${state_bucket}" --project "$project_id" \
  --location "$region" --uniform-bucket-level-access --public-access-prevention
run gcloud storage buckets update "gs://${state_bucket}" --versioning \
  --uniform-bucket-level-access --public-access-prevention

echo "== Smoke-check access for the deploy identity (read only)"
run gcloud projects add-iam-policy-binding "$project_id" --condition=None --quiet \
  --member "serviceAccount:${deployer}" --role roles/browser --format=none
run gcloud storage buckets add-iam-policy-binding "gs://${state_bucket}" \
  --member "serviceAccount:${deployer}" --role roles/storage.legacyBucketReader --format=none

if [[ "$grant_deploy_roles" == true ]]; then
  echo "== Deployer project roles"
  for role in roles/run.admin roles/cloudtasks.admin roles/cloudscheduler.admin \
    roles/artifactregistry.admin roles/storage.admin roles/monitoring.alertPolicyEditor \
    roles/compute.loadBalancerAdmin roles/compute.securityAdmin \
    roles/logging.configWriter roles/serviceusage.serviceUsageConsumer; do
    run gcloud projects add-iam-policy-binding "$project_id" --condition=None --quiet \
      --member "serviceAccount:${deployer}" --role "$role" --format=none
  done

  # Grants on individual secrets need setIamPolicy, not secret access.
  exists gcloud iam roles describe workspaceSecretIamManager --project "$project_id" ||
    run gcloud iam roles create workspaceSecretIamManager --project "$project_id" \
    --title "Workspace secret IAM manager" \
    --permissions secretmanager.secrets.get,secretmanager.secrets.getIamPolicy,secretmanager.secrets.setIamPolicy
  # Bound on each managed secret only, never project-wide.
  for secret_id in "${managed_secrets[@]}"; do
    run gcloud secrets add-iam-policy-binding "$secret_id" --project "$project_id" \
      --member "serviceAccount:${deployer}" \
      --role "projects/${project_id}/roles/workspaceSecretIamManager" --format=none
  done

  echo "== Deployer may attach only the Workspace runtime and invoker accounts"
  for account in "${runtime_accounts[@]}" "${invoker_accounts[@]}"; do
    run gcloud iam service-accounts add-iam-policy-binding "$(sa_email "$account")" \
      --project "$project_id" --member "serviceAccount:${deployer}" \
      --role roles/iam.serviceAccountUser --format=none
  done
else
  echo "== Deploy roles not granted"
  echo "Run the smoke workflow, confirm an untrusted identity is denied, then rerun with --grant-deploy-roles."
fi

cat <<EOF

== Repository configuration (no secret values)
Run these as a repository maintainer, then protect the environment so only
${trusted_ref} can deploy to it:

gh api --method PUT repos/${github_repository}/environments/${environment_name}
gh variable set GCP_SANDBOX_PROJECT_ID --repo ${github_repository} --env ${environment_name} --body ${project_id}
gh variable set GCP_SANDBOX_WIF_PROVIDER --repo ${github_repository} --env ${environment_name} --body ${provider_name}
gh variable set GCP_SANDBOX_DEPLOY_SA --repo ${github_repository} --env ${environment_name} --body ${deployer}
gh variable set GCP_SANDBOX_STATE_BUCKET --repo ${github_repository} --env ${environment_name} --body ${state_bucket}

== Stack configuration identifiers
projectId: ${project_id}
projectNumber: ${project_number}
region: ${region}
stateBucket: ${state_bucket}
budget: ${max_spend} ${currency}, teardown ${teardown_date}
EOF
