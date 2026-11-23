#!/usr/bin/env bash
# Hosted Slice 1-B proof runner for the disposable Workspace sandbox
# (#1452, #1453). `.github/workflows/workspace-gcp-sandbox-smoke.yml` calls
# one phase per step; only that workflow, dispatched on main in the
# workspace-gcp-sandbox environment, can reach the sandbox project.
#
#   sandbox-hosted-proof.sh [--dry-run] <phase|hosted-proof|cleanup-only>...
#
# --dry-run prints the command sequence and never runs gcloud, docker,
# terraform, curl or the release command. Proof state between steps lives in
# SANDBOX_PROOF_DIR (uploaded as a workflow artifact); it never holds a
# token. Every Alchemy write goes through the release command or the
# writer-locked helper, so this runner is never a second stack writer.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
package_dir="$(cd "${script_dir}/.." && pwd)"
repo_root="$(cd "${package_dir}/../.." && pwd)"

hosted_proof_phases=(
  baseline-inventory
  foundation
  images
  deliver-v1
  edge-apply
  deliver-v2
  drift
  interrupt-recover
  state-snapshot-restore
  restore-v1
  edge-privacy
  edge-destroy
  stack-destroy
  post-destroy-inventory
)
cleanup_phases=(edge-destroy stack-destroy post-destroy-inventory)

usage() {
  cat >&2 <<EOF
usage: $0 [--dry-run] <phase>...
  aliases: hosted-proof (${hosted_proof_phases[*]})
           cleanup-only (${cleanup_phases[*]})
  phases:  guard preflight readonly-inventory and every phase above
EOF
  exit 64
}

dry_run=false
if [[ "${1:-}" == "--dry-run" ]]; then
  dry_run=true
  shift
fi
[[ $# -gt 0 ]] || usage

if $dry_run; then
  # Synthetic identifiers only; nothing below reaches Google Cloud.
  : "${GCP_SANDBOX_PROJECT_ID:=deskohub-workspace-sandbox}"
  : "${GCP_SANDBOX_STATE_BUCKET:=deskohub-workspace-sandbox-workspace-state}"
  : "${GCP_SANDBOX_DEPLOY_SA:=workspace-deployer@${GCP_SANDBOX_PROJECT_ID}.iam.gserviceaccount.com}"
  : "${SANDBOX_EXPECTED_PROJECT_ID:=deskohub-workspace-sandbox}"
  : "${SANDBOX_EXPECTED_PROJECT_NUMBER:=759037106024}"
  : "${SANDBOX_EXPECTED_STATE_BUCKET:=deskohub-workspace-sandbox-workspace-state}"
  : "${SANDBOX_REGION:=europe-west1}"
  : "${SANDBOX_PROOF_MODE:=hosted-proof}"
  : "${GITHUB_REF:=refs/heads/main}"
  : "${GITHUB_SHA:=0000000000000000000000000000000000000000}"
  : "${GITHUB_RUN_ID:=0}"
  : "${GITHUB_RUN_ATTEMPT:=1}"
  : "${SANDBOX_PROOF_DIR:=$(mktemp -d)}"
fi

: "${SANDBOX_PROOF_DIR:=${RUNNER_TEMP:-/tmp}/sandbox-proof}"
proof_dir="$SANDBOX_PROOF_DIR"
mkdir -p "$proof_dir"

project_id="${GCP_SANDBOX_PROJECT_ID:-}"
# Alchemy pairs GOOGLE_ACCESS_TOKEN with this project.
export GOOGLE_PROJECT_ID="$project_id"
state_bucket="${GCP_SANDBOX_STATE_BUCKET:-}"
region="${SANDBOX_REGION:-}"
stage=sandbox
stack_prefix="DeskohubWorkspace/${stage}/"
lease_object="${stack_prefix}__lease__.json"
record_object="workspace-release-record.${stage}.json"
edge_prefix="terraform/workspace-edge/sandbox-proof"
web_service=workspace-web
release_services=(workspace-web workspace-tasks-worker workspace-scheduler-worker)
artifact_repository=workspace
probe_image=workspace
collector_image=workspace-otel-collector
mobile_updates_bucket="${project_id}-mobile-updates"
edge_exclusion="workspace-${stage}-token-route-requests"
marker=synthetic-probe-marker
declared_repository_description="Workspace container images, deployed by digest."
plan_log="${proof_dir}/plan.log"

# ---------------------------------------------------------------- helpers

fail() {
  echo "::error::$*" >&2
  exit 1
}
notice() { echo "::notice::$*" >&2; }
warning() { echo "::warning::$*" >&2; }

trace() {
  local line="+"
  local arg
  for arg in "$@"; do line+=" $(printf '%q' "$arg")"; done
  echo "$line" >&2
}

# Run a command, or only print it in a dry run.
run() {
  trace "$@"
  $dry_run || "$@"
}

# Print a command's stdout, or the given placeholder in a dry run.
capture() {
  local placeholder="$1"
  shift
  trace "$@"
  if $dry_run; then
    printf '%s\n' "$placeholder"
  else
    "$@"
  fi
}

# Wait without sleeping in a dry run.
pause() {
  trace sleep "$1"
  $dry_run || sleep "$1"
}

# Assert equality; a dry run only shows the expectation.
expect_equal() {
  local label="$1" actual="$2" expected="$3"
  if $dry_run; then
    echo "  expect ${label} == ${expected}" >&2
    return
  fi
  [[ "$actual" == "$expected" ]] ||
    fail "${label}: expected '${expected}', found '${actual}'"
}

# One JSON value (`null` when absent); a dry run prints a placeholder.
json_get() {
  local path="$1" file="$2"
  if $dry_run; then
    printf 'DRY%s\n' "$path"
  else
    jq -r "$path" "$file"
  fi
}

# A JSON value that must be present.
json_require() {
  local value
  value="$(json_get "$1" "$2")"
  [[ -n "$value" && "$value" != null ]] || fail "missing ${1} in $(basename "$2")"
  printf '%s\n' "$value"
}

phase() { echo "== phase: $1" >&2; }

billing() {
  # Billing APIs bill quota to the caller's project unless told otherwise.
  trace env "CLOUDSDK_BILLING_QUOTA_PROJECT=${project_id}" gcloud billing "$@"
  $dry_run || CLOUDSDK_BILLING_QUOTA_PROJECT="$project_id" gcloud billing "$@"
}

# Alchemy beta.87 rejects federated credential files, so it gets a bearer
# token (google-github-actions/auth `token_format: access_token`). The token
# lives at most one hour; a step past 45 minutes mints a fresh one from the
# federated gcloud credentials, masked before use.
ensure_alchemy_token() {
  if $dry_run; then
    echo "+ (GOOGLE_ACCESS_TOKEN from token_format: access_token; refreshed past 45 minutes)" >&2
    return
  fi
  local now
  now="$(date +%s)"
  if [[ -z "${GOOGLE_ACCESS_TOKEN:-}" ]] ||
    ((now - ${GOOGLE_ACCESS_TOKEN_MINTED_AT:-0} >= 2700)); then
    GOOGLE_ACCESS_TOKEN="$(gcloud auth print-access-token)"
    echo "::add-mask::${GOOGLE_ACCESS_TOKEN}"
    GOOGLE_ACCESS_TOKEN_MINTED_AT="$now"
  fi
  export GOOGLE_ACCESS_TOKEN GOOGLE_ACCESS_TOKEN_MINTED_AT
}

stack_config_file="${proof_dir}/stack-config.json"
digests_file="${proof_dir}/digests.env"
releases_file="${proof_dir}/releases.env"
edge_file="${proof_dir}/edge.env"

load_env_file() {
  # shellcheck disable=SC1090
  [[ -f "$1" ]] && source "$1"
  return 0
}

record_value() {
  local file="$1" key="$2" value="$3"
  touch "$file"
  grep -v "^${key}=" "$file" >"${file}.next" || true
  printf '%s=%q\n' "$key" "$value" >>"${file}.next"
  mv "${file}.next" "$file"
}

# The sandbox stack config, generated from the verified identity and decoded
# with the package's own schema before any use.
write_stack_config() {
  local collector_digest="${1:-}"
  trace bun scripts/sandbox-stack-config.ts
  (
    cd "$package_dir"
    SANDBOX_PROJECT_ID="$project_id" \
      SANDBOX_PROJECT_NUMBER="${SANDBOX_EXPECTED_PROJECT_NUMBER}" \
      SANDBOX_REGION="$region" \
      SANDBOX_STATE_BUCKET="$state_bucket" \
      SANDBOX_TELEMETRY_COLLECTOR_DIGEST="$collector_digest" \
      SANDBOX_STACK_CONFIG_DRY_RUN="$dry_run" \
      bun scripts/sandbox-stack-config.ts
  ) >"${stack_config_file}.next"
  mv "${stack_config_file}.next" "$stack_config_file"
}

use_stack_config() {
  [[ -f "$stack_config_file" ]] || {
    load_env_file "$digests_file"
    write_stack_config "${COLLECTOR_DIGEST:-}"
  }
  WORKSPACE_STACK_CONFIG="$(cat "$stack_config_file")"
  export WORKSPACE_STACK_CONFIG
}

# `bun run release <command>` as the stage's only writer.
release() {
  use_stack_config
  trace bun run release "$@"
  $dry_run || (cd "$package_dir" && bun release.run.ts "$@")
}

dry_status='{"version":"1","record":{"generation":1,"writer":null,"pendingApply":null}}'

# `release status` into a named artifact file; prints the file path.
release_status() {
  local file="${proof_dir}/status-$1.json"
  use_stack_config
  trace bun run release status
  if $dry_run; then
    printf '%s\n' "$dry_status" >"$file"
  else
    (cd "$package_dir" && bun release.run.ts status) >"$file"
  fi
  printf '%s\n' "$file"
}

# Writer-locked Alchemy commands the release command has no verb for.
locked_stack() {
  use_stack_config
  trace bun scripts/sandbox-locked-stack.ts "$@"
  $dry_run && return 0
  (cd "$package_dir" && bun scripts/sandbox-locked-stack.ts "$@")
}

expect_settled() {
  local status="$1" digest="${2:-}"
  expect_equal "writer lock" "$(json_get '.record.writer' "$status")" null
  expect_equal "pending apply" "$(json_get '.record.pendingApply' "$status")" null
  if [[ -n "$digest" ]]; then
    expect_equal "active digest" "$(json_require '.record.active.imageDigest' "$status")" "$digest"
  fi
}

# `release plan` must report no changes.
expect_no_op_plan() {
  release plan | tee "$plan_log"
  $dry_run && {
    echo "  expect plan summary: no changes" >&2
    return
  }
  local summary
  summary="$(sed 's/\x1b\[[0-9;]*m//g' "$plan_log")"
  if grep -Eq '[0-9]+ to (create|update|replace|delete|adopted|orphaned)' <<<"$summary"; then
    fail "release plan is not a no-op; see the plan log"
  fi
  grep -q 'no changes' <<<"$summary" ||
    fail "release plan printed no recognizable summary"
}

edge_ip() {
  load_env_file "$edge_file"
  if $dry_run; then
    echo "${EDGE_IP:-198.51.100.10}"
  else
    [[ -n "${EDGE_IP:-}" ]] || fail "the edge has no recorded IP address"
    echo "$EDGE_IP"
  fi
}

# Every one of several requests through the load balancer must report the
# expected probe build: proof that it serves 100% of untagged traffic.
expect_serving() {
  local version="$1" ip attempt served=0 body
  ip="$(edge_ip)"
  trace curl -fsS "http://${ip}/healthz" "(x10, until version=${version})"
  $dry_run && return 0
  for attempt in $(seq 1 60); do
    served=0
    for _ in $(seq 1 10); do
      body="$(curl -fsS --max-time 10 "http://${ip}/healthz" 2>/dev/null || true)"
      [[ "$(jq -r '.version // empty' <<<"$body" 2>/dev/null)" == "$version" ]] &&
        served=$((served + 1))
    done
    ((served == 10)) && {
      echo "edge serves ${version} on 10/10 requests (attempt ${attempt})"
      return 0
    }
    sleep 10
  done
  fail "the edge did not serve ${version} on every request (${served}/10)"
}

terraform_edge() {
  local action="$1"
  local dir="${repo_root}/infra/workspace-edge"
  export TF_DATA_DIR="${proof_dir}/terraform" TF_IN_AUTOMATION=1
  run terraform -chdir="$dir" init -input=false -lockfile=readonly \
    -backend-config="bucket=${state_bucket}" \
    -backend-config="prefix=${edge_prefix}"
  run terraform -chdir="$dir" "$action" -input=false -auto-approve \
    -var "project_id=${project_id}" \
    -var "stage=${stage}" \
    -var "region=${region}" \
    -var "web_service_name=${web_service}" \
    -var 'domains=[]' \
    -var static_cdn_enabled=false \
    -var waf_preview=true \
    -var enable_https=false
}

object_generation() {
  capture 1 gcloud storage objects describe "gs://${state_bucket}/$1" \
    --format='value(generation)' 2>/dev/null || true
}

# No Alchemy lease holder: a live holder refreshes the 60 s lease well
# within a minute, so an unchanged generation over 65 s means none.
wait_for_quiet_lease() {
  local before after
  before="$(object_generation "$lease_object")"
  pause 65
  after="$(object_generation "$lease_object")"
  expect_equal "Alchemy lease generation over 65 s" "$after" "$before"
}

stack_objects_json() {
  capture '[]' gcloud storage objects list "gs://${state_bucket}/${stack_prefix}**" --format=json
}

# List one resource class into an inventory file. A denied or failed list
# is recorded as unverified, never as empty.
inventory_class() {
  local dir="$1" class="$2"
  shift 2
  trace "$@"
  $dry_run && return 0
  if "$@" >"${dir}/${class}.txt" 2>"${dir}/${class}.err"; then
    rm -f "${dir}/${class}.err"
  else
    echo "UNVERIFIED" >"${dir}/${class}.txt"
    notice "${class}: listing failed (permission or API); unverified, not empty"
  fi
}

take_inventory() {
  local dir="${proof_dir}/inventory-$1"
  mkdir -p "$dir"
  local p=(--project="$project_id")
  inventory_class "$dir" run-services gcloud run services list "${p[@]}" --region="$region" --format='value(metadata.name)'
  inventory_class "$dir" artifact-repositories gcloud artifacts repositories list "${p[@]}" --location="$region" --format='value(name)'
  inventory_class "$dir" forwarding-rules gcloud compute forwarding-rules list "${p[@]}" --global --format='value(name)'
  inventory_class "$dir" addresses gcloud compute addresses list "${p[@]}" --global --format='value(name)'
  inventory_class "$dir" backend-services gcloud compute backend-services list "${p[@]}" --global --format='value(name)'
  inventory_class "$dir" url-maps gcloud compute url-maps list "${p[@]}" --global --format='value(name)'
  inventory_class "$dir" target-http-proxies gcloud compute target-http-proxies list "${p[@]}" --global --format='value(name)'
  inventory_class "$dir" target-https-proxies gcloud compute target-https-proxies list "${p[@]}" --global --format='value(name)'
  inventory_class "$dir" network-endpoint-groups gcloud compute network-endpoint-groups list "${p[@]}" --regions="$region" --format='value(name)'
  inventory_class "$dir" security-policies gcloud compute security-policies list "${p[@]}" --format='value(name)'
  inventory_class "$dir" ssl-certificates gcloud compute ssl-certificates list "${p[@]}" --global --format='value(name)'
  inventory_class "$dir" logging-exclusions gcloud logging exclusions list "${p[@]}" --format='value(name)'
  inventory_class "$dir" logging-sinks gcloud logging sinks list "${p[@]}" --format='value(name,destination)'
  inventory_class "$dir" tasks-queues gcloud tasks queues list "${p[@]}" --location="$region" --format='value(name)'
  inventory_class "$dir" scheduler-jobs gcloud scheduler jobs list "${p[@]}" --location="$region" --format='value(name)'
  inventory_class "$dir" storage-buckets gcloud storage buckets list "${p[@]}" --format='value(name)'
  inventory_class "$dir" state-objects gcloud storage ls -r "gs://${state_bucket}/"
}

# What counts as a proof resource in each class. The shared state bucket,
# WIF, deployer, the Terraform state file and release record history are
# preserved by design and not matched.
proof_pattern() {
  case "$1" in
    run-services) echo '^workspace-' ;;
    artifact-repositories) echo "/repositories/${artifact_repository}\$" ;;
    forwarding-rules | addresses | backend-services | url-maps | target-http-proxies | target-https-proxies | network-endpoint-groups | security-policies | ssl-certificates)
      echo "^workspace-${stage}-" ;;
    logging-exclusions) echo "^${edge_exclusion}\$" ;;
    tasks-queues) echo '/queues/workspace-' ;;
    scheduler-jobs) echo '/jobs/workspace-' ;;
    storage-buckets) echo "^(gs://)?${mobile_updates_bucket}/?\$" ;;
    state-objects) echo "${stack_prefix}[^_]" ;;
    *) echo '^$' ;;
  esac
}

# ---------------------------------------------------------------- phases

# Before authenticating: mutating modes only on main, only against the
# approved sandbox identifiers.
phase_guard() {
  case "${SANDBOX_PROOF_MODE:-}" in
    hosted-proof | cleanup-only) ;;
    *) fail "guard is only for the hosted-proof and cleanup-only modes" ;;
  esac
  [[ "${GITHUB_REF:-}" == "refs/heads/main" ]] ||
    fail "mutating sandbox modes run only from refs/heads/main"
  [[ "$project_id" == "${SANDBOX_EXPECTED_PROJECT_ID:-}" ]] ||
    fail "GCP_SANDBOX_PROJECT_ID is not the approved sandbox project"
  [[ "$state_bucket" == "${SANDBOX_EXPECTED_STATE_BUCKET:-}" ]] ||
    fail "GCP_SANDBOX_STATE_BUCKET is not the approved sandbox state bucket"
  [[ "$region" == "europe-west1" ]] || fail "the sandbox region is europe-west1"
  [[ "${SANDBOX_EXPECTED_PROJECT_NUMBER:-}" =~ ^[1-9][0-9]{5,19}$ ]] ||
    fail "SANDBOX_EXPECTED_PROJECT_NUMBER is not a project number"
  [[ "${GCP_SANDBOX_DEPLOY_SA:-}" == "workspace-deployer@${project_id}.iam.gserviceaccount.com" ]] ||
    fail "GCP_SANDBOX_DEPLOY_SA is not the sandbox deployer"
  echo "guard passed for ${SANDBOX_PROOF_MODE} on ${GITHUB_REF}"
}

# After authenticating: the live project number and bucket region match,
# then the decoded stack config is written.
phase_preflight() {
  local number location
  number="$(capture "$SANDBOX_EXPECTED_PROJECT_NUMBER" gcloud projects describe "$project_id" --format='value(projectNumber)')"
  expect_equal "project number" "$number" "$SANDBOX_EXPECTED_PROJECT_NUMBER"
  location="$(capture "$region" gcloud storage buckets describe "gs://${state_bucket}" --format='value(location)')"
  expect_equal "state bucket location" "${location,,}" "$region"
  load_env_file "$digests_file"
  write_stack_config "${COLLECTOR_DIGEST:-}"
}

# Read-only: billing link, enabled APIs the proof needs, log routing.
phase_readonly_inventory() {
  billing projects describe "$project_id" --format='value(billingEnabled,billingAccountName)' ||
    notice "billing link unverified (denied)"
  local enabled api
  if enabled="$(capture "" gcloud services list --enabled --project="$project_id" --format='value(config.name)')"; then
    for api in run.googleapis.com artifactregistry.googleapis.com cloudtasks.googleapis.com \
      compute.googleapis.com logging.googleapis.com monitoring.googleapis.com \
      cloudtrace.googleapis.com telemetry.googleapis.com secretmanager.googleapis.com; do
      if $dry_run; then
        continue
      elif grep -qx "$api" <<<"$enabled"; then
        echo "enabled: ${api}"
      else
        notice "not enabled: ${api}"
      fi
    done
  else
    notice "enabled APIs unverified (denied)"
  fi
  run gcloud logging sinks list --project="$project_id" --format='table(name,destination,filter)' ||
    notice "log sinks unverified (denied); inherited folder/organization sinks are not listed"
  run gcloud logging exclusions list --project="$project_id" --format='table(name,filter,disabled)' ||
    notice "log exclusions unverified (denied)"
}

phase_baseline_inventory() {
  take_inventory baseline
}

phase_foundation() {
  write_stack_config
  # An empty record declares no release-owned service: foundation only.
  release deploy
}

build_and_push() {
  local key="$1" image="$2" tag="$3" dockerfile="$4" context="$5"
  shift 5
  local reference="${region}-docker.pkg.dev/${project_id}/${artifact_repository}/${image}:${tag}"
  local metadata="${proof_dir}/build-${key}.json"
  run docker buildx build --platform linux/amd64 --provenance=false --sbom=false \
    --push --metadata-file "$metadata" --tag "$reference" --file "$dockerfile" "$@" "$context"
  local digest
  if $dry_run; then
    digest="sha256:$(printf '%064d' "${#key}")"
  else
    digest="$(jq -r '."containerimage.digest"' "$metadata")"
  fi
  [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || fail "no pushed digest for ${key}"
  record_value "$digests_file" "$key" "$digest"
  echo "${key}=${digest}"
}

phase_images() {
  run gcloud auth configure-docker "${region}-docker.pkg.dev" --quiet
  local probe="${package_dir}/sandbox-probe"
  local suffix="${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
  local version
  for version in v1 v2 v3; do
    build_and_push "PROBE_${version^^}_DIGEST" "$probe_image" "probe-${version}-${suffix}" \
      "${probe}/Dockerfile" "$probe" --build-arg "PROBE_BUILD_VERSION=${version}"
  done
  build_and_push COLLECTOR_DIGEST "$collector_image" "collector-${suffix}" \
    "${probe}/collector.Dockerfile" "$repo_root"
  load_env_file "$digests_file"
  # Before any release exists, so every revision carries the sidecar.
  write_stack_config "$COLLECTOR_DIGEST"
}

phase_deliver_v1() {
  load_env_file "$digests_file"
  release deliver --sha "$GITHUB_SHA" --image-digest "${PROBE_V1_DIGEST:-}"
  local status
  status="$(release_status after-v1)"
  expect_settled "$status" "${PROBE_V1_DIGEST:-}"
  record_value "$releases_file" V1_RELEASE_ID "$(json_require '.record.active.releaseId' "$status")"
  expect_no_op_plan
}

# The web service only admits load-balancer traffic (ingress
# INTERNAL_LOAD_BALANCER), so every HTTP check goes through this edge.
phase_edge_apply() {
  terraform_edge apply
  local dir="${repo_root}/infra/workspace-edge" protocol ip
  protocol="$(capture http terraform -chdir="$dir" output -raw edge_protocol)"
  expect_equal "edge protocol" "$protocol" http
  ip="$(capture 198.51.100.10 terraform -chdir="$dir" output -raw edge_ip_address)"
  record_value "$edge_file" EDGE_IP "$ip"
  run terraform -chdir="$dir" output -json
  expect_serving v1
  local robots
  robots="$(capture 'text/plain' curl -fsS -o /dev/null -w '%{content_type}' "http://${ip}/robots.txt")"
  [[ "$robots" == text/plain* ]] || fail "/robots.txt is not text/plain"
}

phase_deliver_v2() {
  load_env_file "$digests_file"
  release deliver --sha "$GITHUB_SHA" --image-digest "${PROBE_V2_DIGEST:-}"
  local status
  status="$(release_status after-v2)"
  expect_settled "$status" "${PROBE_V2_DIGEST:-}"
  record_value "$releases_file" V2_RELEASE_ID "$(json_require '.record.active.releaseId' "$status")"
  expect_serving v2
}

repository_description() {
  capture "$declared_repository_description" gcloud artifacts repositories describe \
    "$artifact_repository" --project="$project_id" --location="$region" \
    --format='value(description)'
}

# Out-of-band change to a safe declared field, detected by readback and
# Alchemy drift, repaired under the writer lock, then a no-op plan.
phase_drift() {
  local injected="sandbox proof drift ${GITHUB_RUN_ID}"
  run gcloud artifacts repositories update "$artifact_repository" \
    --project="$project_id" --location="$region" --description="$injected"
  expect_equal "drifted description" "$(repository_description)" "$injected"
  local code=0
  locked_stack drift || code=$?
  $dry_run && code=2
  [[ "$code" == 2 ]] || fail "Alchemy reported no drift (exit ${code})"
  locked_stack repair
  expect_equal "repaired description" "$(repository_description)" "$declared_repository_description"
  release deploy
  expect_no_op_plan
}

# Kill an in-flight `release deliver` once its Alchemy apply holds the
# lease, then recover: the writer lock has no expiry, so the confirmed-dead
# holder is cleared with `release unlock --holder`, any pending traffic
# change is settled by `release recover`, and the deliver is rerun.
phase_interrupt_recover() {
  load_env_file "$digests_file"
  expect_settled "$(release_status before-interrupt)"
  local before log="${proof_dir}/interrupted-deliver.log"
  before="$(object_generation "$lease_object")"
  use_stack_config
  trace setsid bun run release deliver --sha "$GITHUB_SHA" --image-digest "${PROBE_V3_DIGEST:-}" "&"
  if ! $dry_run; then
    (cd "$package_dir" && exec setsid bun release.run.ts deliver \
      --sha "$GITHUB_SHA" --image-digest "$PROBE_V3_DIGEST") >"$log" 2>&1 &
    local pid=$! interrupted=false
    for _ in $(seq 1 600); do
      if ! kill -0 "$pid" 2>/dev/null; then
        break
      fi
      if [[ "$(object_generation "$lease_object")" != "$before" ]]; then
        kill -KILL -- "-${pid}" 2>/dev/null || kill -KILL "$pid"
        interrupted=true
        break
      fi
      sleep 0.5
    done
    wait "$pid" 2>/dev/null || true
    $interrupted || fail "the deliver ended before its apply took the lease; nothing was interrupted"
    pgrep -s "$pid" >/dev/null && fail "processes of the interrupted deliver are still running"
  fi
  echo "interrupted deliver during its Alchemy apply"
  pause 75
  local status holder
  status="$(release_status interrupted)"
  holder="$(json_get '.record.writer.holder' "$status")"
  [[ -n "$holder" && "$holder" != null ]] || fail "the interrupted deliver left no writer lock"
  local unlocked=false
  for _ in $(seq 1 20); do
    if release unlock --holder "$holder"; then
      unlocked=true
      break
    fi
    $dry_run && break
    sleep 15
  done
  $dry_run || $unlocked || fail "the stale writer lock could not be cleared"
  status="$(release_status unlocked)"
  if [[ "$(json_get '.record.pendingApply' "$status")" != null ]]; then
    release recover
    status="$(release_status recovered)"
  fi
  if [[ "$(json_get '.record.active.imageDigest' "$status")" != "${PROBE_V3_DIGEST:-}" ]]; then
    release deliver --sha "$GITHUB_SHA" --image-digest "${PROBE_V3_DIGEST:-}"
  fi
  status="$(release_status after-recovery)"
  expect_settled "$status" "${PROBE_V3_DIGEST:-}"
  expect_no_op_plan
  expect_serving v3
}

# Snapshot exact generations of the stack's Alchemy state objects, make a
# tracked change (restore traffic to v2), restore those generations, read
# them back and reconcile. Never while a lock or lease is held.
phase_state_snapshot_restore() {
  load_env_file "$releases_file"
  expect_settled "$(release_status before-snapshot)"
  wait_for_quiet_lease
  local snapshot="${proof_dir}/state-snapshot.json" changed="${proof_dir}/state-changed.json"
  stack_objects_json | jq_filter_lease >"$snapshot"

  local status generation
  status="$(release_status before-tracked-change)"
  generation="$(json_require '.record.generation' "$status")"
  release restore --release-id "${V2_RELEASE_ID:-}" --expected-generation "$generation"
  expect_serving v2

  expect_settled "$(release_status after-tracked-change)"
  wait_for_quiet_lease
  stack_objects_json | jq_filter_lease >"$changed"
  if ! $dry_run; then
    jq -e --slurpfile before "$snapshot" \
      '. != $before[0]' "$changed" >/dev/null ||
      fail "the tracked change wrote no Alchemy state object"
  fi

  local name generation_wanted
  if ! $dry_run; then
    while IFS=$'\t' read -r name generation_wanted; do
      if [[ "$(jq -r --arg n "$name" '.[] | select(.name == $n) | .generation' "$changed")" != "$generation_wanted" ]]; then
        run gcloud storage cp "gs://${state_bucket}/${name}#${generation_wanted}" "gs://${state_bucket}/${name}"
      fi
    done < <(jq -r '.[] | [.name, .generation] | @tsv' "$snapshot")
    while read -r name; do
      run gcloud storage rm "gs://${state_bucket}/${name}"
    done < <(jq -r --slurpfile before "$snapshot" \
      '($before[0] | map(.name)) as $kept | .[] | select(.name as $n | $kept | index($n) | not) | .name' "$changed")
  else
    trace gcloud storage cp "gs://${state_bucket}/<object>#<snapshot generation>" "gs://${state_bucket}/<object>"
    trace gcloud storage rm "gs://${state_bucket}/<object created after the snapshot>"
  fi

  local restored="${proof_dir}/state-restored.json"
  stack_objects_json | jq_filter_lease >"$restored"
  if ! $dry_run; then
    jq -e --slurpfile before "$snapshot" \
      '(map({name, crc32c}) | sort) == ($before[0] | map({name, crc32c}) | sort)' \
      "$restored" >/dev/null || fail "restored state objects do not match the snapshot"
  fi
  echo "Alchemy state restored to the snapshot generations"

  release deploy
  expect_no_op_plan
  expect_settled "$(release_status after-state-restore)"
  expect_serving v2
}

jq_filter_lease() {
  if $dry_run; then
    cat
  else
    jq --arg lease "$lease_object" \
      '[.[] | select(.name != $lease) | {name, generation: (.generation | tostring), crc32c: .crc32c_hash}] | sort_by(.name)'
  fi
}

phase_restore_v1() {
  load_env_file "$releases_file"
  load_env_file "$digests_file"
  local status generation
  status="$(release_status before-restore)"
  generation="$(json_require '.record.generation' "$status")"
  release restore --release-id "${V1_RELEASE_ID:-}" --expected-generation "$generation"
  expect_settled "$(release_status after-restore)" "${PROBE_V1_DIGEST:-}"
  expect_serving v1
}

# Token-route requests carry a synthetic marker; it must not reach any log
# or trace this identity can read. Unreadable sources are reported, never
# counted as clean.
phase_edge_privacy() {
  local ip path body
  ip="$(edge_ip)"
  for path in /app/auth/callback /api/auth/magic-link/verify /marketing-preferences/access; do
    body="$(capture "{\"route\":\"${path}\"}" curl -fsS --max-time 10 "http://${ip}${path}?token=${marker}")"
    [[ "$body" != *"$marker"* ]] || fail "${path} echoed the marker"
  done
  pause 90

  local logs
  if logs="$(capture '[]' gcloud logging read "\"${marker}\"" --project="$project_id" \
    --freshness=1h --limit=20 --format='json(logName,timestamp)')"; then
    [[ "$(jq 'length' <<<"$logs")" == 0 ]] ||
      fail "the marker reached readable logs: $(jq -c '[.[] | .logName]' <<<"$logs")"
    echo "marker absent from readable Cloud Logging entries"
  else
    notice "Cloud Logging is not readable by the deployer; marker absence in logs unverified"
  fi
  local requests
  if requests="$(capture '[{}]' gcloud logging read \
    "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${web_service}\"" \
    --project="$project_id" --freshness=1h --limit=1 --format='json(timestamp)')"; then
    [[ "$(jq 'length' <<<"$requests")" != 0 ]] ||
      notice "no readable Cloud Run log entries; marker absence proves little"
  fi

  if ! $dry_run; then
    local start traces
    start="$(date -u -d '-1 hour' +%Y-%m-%dT%H:%M:%SZ)"
    if traces="$(printf 'Authorization: Bearer %s\n' "$(gcloud auth print-access-token)" |
      curl -fsS -H @- "https://cloudtrace.googleapis.com/v1/projects/${project_id}/traces?view=COMPLETE&pageSize=100&startTime=${start}")"; then
      [[ "$traces" != *"$marker"* ]] || fail "the marker reached Cloud Trace"
      echo "marker absent from readable Cloud Trace spans"
    else
      notice "Cloud Trace is not readable by the deployer; marker absence in traces unverified"
    fi
  else
    trace curl https://cloudtrace.googleapis.com/v1/projects/"${project_id}"/traces "(bearer from gcloud, never printed)"
  fi

  local dir="${proof_dir}/log-routing"
  mkdir -p "$dir"
  inventory_class "$dir" logging-sinks gcloud logging sinks list --project="$project_id" --format='json(name,destination,filter,exclusions)'
  inventory_class "$dir" logging-exclusions gcloud logging exclusions list --project="$project_id" --format='value(name)'
  if ! $dry_run && [[ "$(cat "${dir}/logging-exclusions.txt")" != UNVERIFIED ]]; then
    grep -qx "$edge_exclusion" "${dir}/logging-exclusions.txt" ||
      fail "the token-route request-log exclusion is missing"
  fi
}

phase_edge_destroy() {
  terraform_edge destroy
}

# Scoped destroy of exactly the sandbox stack, under the writer lock. The
# state bucket, WIF, deployer and Terraform state stay; the release record's
# live object is removed so the next proof starts from an empty record, and
# its generations stay as noncurrent history in the versioned bucket.
phase_stack_destroy() {
  local status holder
  status="$(release_status before-destroy)"
  holder="$(json_get '.record.writer.holder' "$status")"
  if ! $dry_run && [[ -n "$holder" && "$holder" != null ]]; then
    # The concurrency group never runs two sandbox jobs, and every earlier
    # step of this job has exited: the holder is confirmed dead.
    wait_for_quiet_lease
    release unlock --holder "$holder"
    status="$(release_status destroy-unlocked)"
  fi
  if ! $dry_run && [[ "$(json_get '.record.pendingApply' "$status")" != null ]]; then
    release recover || warning "recover failed; destroy may refuse the pending apply"
  fi
  if locked_stack destroy; then
    run gcloud storage rm "gs://${state_bucket}/${record_object}" ||
      warning "the release record's live object could not be removed"
    return 0
  fi
  warning "Alchemy destroy failed; deleting billable proof resources directly"
  local service queue
  for service in "${release_services[@]}"; do
    run gcloud run services delete "$service" --project="$project_id" --region="$region" --quiet || true
  done
  for queue in $(capture '' gcloud tasks queues list --project="$project_id" --location="$region" \
    --filter='name~/queues/workspace-' --format='value(name.basename())'); do
    run gcloud tasks queues delete "$queue" --project="$project_id" --location="$region" --quiet || true
  done
  run gcloud artifacts repositories delete "$artifact_repository" --project="$project_id" \
    --location="$region" --quiet || true
  fail "Alchemy destroy failed; the stack state under ${stack_prefix} needs an operator"
}

phase_post_destroy_inventory() {
  take_inventory post-destroy
  local dir="${proof_dir}/inventory-post-destroy" file class pattern residual=false unverified=()
  if ! $dry_run; then
    for file in "$dir"/*.txt; do
      class="$(basename "$file" .txt)"
      if [[ "$(cat "$file")" == UNVERIFIED ]]; then
        unverified+=("$class")
        continue
      fi
      pattern="$(proof_pattern "$class")"
      if grep -E "$pattern" "$file" >"${dir}/${class}.residual"; then
        residual=true
        echo "::error::proof resources remain in ${class}: $(tr '\n' ' ' <"${dir}/${class}.residual")"
      else
        rm -f "${dir}/${class}.residual"
      fi
    done
  fi
  ((${#unverified[@]} == 0)) || notice "unverified after destroy: ${unverified[*]}"
  billing projects describe "$project_id" --format='value(billingEnabled,billingAccountName)' ||
    notice "billing link unverified (denied)"
  ! $residual || fail "proof resources remain after teardown"
  echo "no proof resources remain in any verified class"
}

# ---------------------------------------------------------------- dispatch

run_phase() {
  local name="$1"
  phase "$name"
  case "$name" in
    guard | readonly-inventory) ;;
    # Refreshed in this shell, never inside a command substitution, so
    # the mask applies and every later command sees the token.
    *) ensure_alchemy_token ;;
  esac
  case "$name" in
    guard) phase_guard ;;
    preflight) phase_preflight ;;
    readonly-inventory) phase_readonly_inventory ;;
    baseline-inventory) phase_baseline_inventory ;;
    foundation) phase_foundation ;;
    images) phase_images ;;
    deliver-v1) phase_deliver_v1 ;;
    edge-apply) phase_edge_apply ;;
    deliver-v2) phase_deliver_v2 ;;
    drift) phase_drift ;;
    interrupt-recover) phase_interrupt_recover ;;
    state-snapshot-restore) phase_state_snapshot_restore ;;
    restore-v1) phase_restore_v1 ;;
    edge-privacy) phase_edge_privacy ;;
    edge-destroy) phase_edge_destroy ;;
    stack-destroy) phase_stack_destroy ;;
    post-destroy-inventory) phase_post_destroy_inventory ;;
    *) usage ;;
  esac
}

for argument in "$@"; do
  case "$argument" in
    hosted-proof) for p in "${hosted_proof_phases[@]}"; do run_phase "$p"; done ;;
    cleanup-only) for p in "${cleanup_phases[@]}"; do run_phase "$p"; done ;;
    *) run_phase "$argument" ;;
  esac
done
