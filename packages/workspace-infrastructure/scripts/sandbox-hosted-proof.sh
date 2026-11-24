#!/usr/bin/env bash
# Hosted Slice 1-B proof runner for the disposable Workspace sandbox
# (#1452, #1453). `.github/workflows/workspace-gcp-sandbox-smoke.yml` calls
# one phase per step; only that workflow, dispatched on main in the
# workspace-gcp-sandbox environment, can reach the sandbox project.
#
#   sandbox-hosted-proof.sh [--dry-run] <phase|hosted-proof|cleanup-only>...
#
# --dry-run prints the command sequence and never runs gcloud, docker,
# curl or the release command. Proof state between steps lives in
# SANDBOX_PROOF_DIR (uploaded as a workflow artifact); it never holds a
# token. Every Alchemy write goes through the release command or the
# writer-locked helper, so this runner is never a second stack writer. The
# edge is part of the same stack: the first release declares it, the
# runner reads its outputs back, and the stack destroy removes it.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
package_dir="$(cd "${script_dir}/.." && pwd)"
repo_root="$(cd "${package_dir}/../.." && pwd)"

hosted_proof_phases=(
  baseline-inventory
  foundation
  images
  deliver-v1
  edge-readback
  deliver-v2
  drift
  interrupt-recover
  state-snapshot-restore
  restore-v1
  edge-privacy
  stack-destroy
  post-destroy-inventory
)
cleanup_phases=(stack-destroy post-destroy-inventory)

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
web_service=workspace-web
release_services=(workspace-web workspace-tasks-worker workspace-scheduler-worker)
artifact_repository=workspace
probe_image=workspace
collector_image=workspace-otel-collector
mobile_updates_bucket="${project_id}-mobile-updates"
edge_exclusion="workspace-${stage}-token-route-requests"
edge_security_policy="workspace-${stage}-edge"
edge_backend_services=("workspace-${stage}-dynamic" "workspace-${stage}-static")
# The auth throttle's requests per minute: the stack config's default.
edge_auth_rate_limit=120
marker=synthetic-probe-marker
# Token-bearing routes the privacy phase sends the marker to.
token_routes=(/app/auth/callback /api/auth/magic-link/verify /marketing-preferences/access)
# Request sources that record the full URL of a token-route request.
token_request_sources=('resource.type="http_load_balancer"' 'resource.type="cloud_run_revision"' 'log_id("run.googleapis.com/requests")')
dry_run_exclusion_filter='(resource.type="http_load_balancer" OR (resource.type="cloud_run_revision" AND log_id("run.googleapis.com/requests"))) AND httpRequest.requestUrl=~"^https?://[^/]+(/app/auth/callback|/api/auth/magic-link/verify|/marketing-preferences/access)([/?#]|$)"'
declared_repository_description="Workspace container images, deployed by digest."
plan_log="${proof_dir}/plan.log"
# How long the edge may take to serve a version: a new global load
# balancer's first propagation, then a revision change on a live one. Each
# fits inside its workflow step's limit.
: "${SANDBOX_FIRST_SERVING_TIMEOUT_SECONDS:=1080}"
: "${SANDBOX_SERVING_TIMEOUT_SECONDS:=600}"

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

# GET one Google API resource. The bearer token goes to curl on stdin, so it
# is never traced or visible in the process list; any HTTP error fails. A dry
# run prints the placeholder.
google_get() {
  local placeholder="$1" url="$2"
  trace curl -fsS "$url" "(bearer from gcloud, never printed)"
  if $dry_run; then
    printf '%s\n' "$placeholder"
    return 0
  fi
  local token
  token="$(gcloud auth print-access-token)" || return 1
  printf 'Authorization: Bearer %s\n' "$token" |
    curl -fsS --max-time 30 -H @- "$url"
}

# The project's log exclusions as a JSON array, from the Logging API: the
# pinned SDK has no `gcloud logging exclusions` group. A second page fails
# rather than being ignored.
project_exclusions_json() {
  local body
  body="$(google_get '{"exclusions":[]}' \
    "https://logging.googleapis.com/v2/projects/${project_id}/exclusions?pageSize=100")" ||
    return 1
  if $dry_run; then
    echo '[]'
    return 0
  fi
  jq -e '.nextPageToken == null' >/dev/null <<<"$body" || return 1
  jq -c '.exclusions // []' <<<"$body"
}

project_exclusion_names() {
  local exclusions
  exclusions="$(project_exclusions_json)" || return 1
  $dry_run || jq -r '.[] | .name' <<<"$exclusions"
}

# A token's expiry from Google's tokeninfo, in epoch seconds: the reported
# lifetime counted from before the request, so a slow reply only makes it
# earlier. The token goes in the request body, never on a command line.
token_expiry() {
  local start seconds
  start="$(date +%s)"
  seconds="$(printf '%s' "$1" |
    curl -sS --fail-with-body --data-urlencode 'access_token@-' \
      https://oauth2.googleapis.com/tokeninfo | jq -r '.expires_in // empty')" || return 1
  [[ "$seconds" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$((start + seconds))"
}

# Alchemy beta.87 rejects federated credential files, so it gets a bearer
# token (google-github-actions/auth `token_format: access_token`). The token
# lives at most one hour. Every phase that runs Alchemy starts with at
# least its 30-minute budget (the longest, the stack destroy) left: a
# token's expiry is its own, from tokeninfo, never an estimate, and a token
# closer to it is replaced by a fresh one from the federated gcloud
# credentials, masked before use. An empty gcloud config has no token
# cache, so gcloud cannot hand back a cached token near its expiry.
ensure_alchemy_token() {
  if $dry_run; then
    echo "+ (GOOGLE_ACCESS_TOKEN from token_format: access_token; refreshed under 30 minutes left)" >&2
    return
  fi
  local expires_at="${GOOGLE_ACCESS_TOKEN_EXPIRES_AT:-}" now
  if ! [[ "$expires_at" =~ ^[0-9]+$ ]]; then
    # The workflow's token: an unreadable lifetime counts as expired.
    if [[ -z "${GOOGLE_ACCESS_TOKEN:-}" ]] ||
      ! expires_at="$(token_expiry "$GOOGLE_ACCESS_TOKEN")"; then
      expires_at=0
    fi
  fi
  # Read after any lookup, so its time counts against the token.
  now="$(date +%s)"
  if [[ -z "${GOOGLE_ACCESS_TOKEN:-}" ]] || ((expires_at - now < 1800)); then
    local config
    config="$(mktemp -d)"
    GOOGLE_ACCESS_TOKEN="$(CLOUDSDK_CONFIG="$config" gcloud auth print-access-token)"
    rm -rf "${config:?}"
    echo "::add-mask::${GOOGLE_ACCESS_TOKEN}"
    expires_at="$(token_expiry "$GOOGLE_ACCESS_TOKEN")" ||
      fail "the minted access token's lifetime is unreadable"
    now="$(date +%s)"
    ((expires_at - now >= 1800)) ||
      fail "the minted access token expires in $((expires_at - now)) s, under the 30-minute step budget"
  fi
  GOOGLE_ACCESS_TOKEN_EXPIRES_AT="$expires_at"
  export GOOGLE_ACCESS_TOKEN GOOGLE_ACCESS_TOKEN_EXPIRES_AT
}

stack_config_file="${proof_dir}/stack-config.json"
digests_file="${proof_dir}/digests.env"
releases_file="${proof_dir}/releases.env"
edge_file="${proof_dir}/edge.env"
edge_outputs_file="${proof_dir}/edge-outputs.json"
exclusion_filter_file="${proof_dir}/edge-exclusion-filter.txt"
# The proof run's disposable queue ID suffix, kept in the state bucket
# outside the stack prefix so a later cleanup-only run declares the same
# queues. Removed with the stack.
proof_run_file="${proof_dir}/proof-run.env"
proof_run_object="sandbox-proof/run.env"
# The writer-lock holder whose processes the interrupt phase proved dead.
dead_holder_file="${proof_dir}/interrupted-dead-holder"
# Hosted proof starts only this long before the teardown deadline, leaving
# time for its own teardown and a cleanup-only rerun.
hosted_proof_teardown_margin_seconds=86400

# Read KEY=value records as data, never as shell: the proof run record comes
# back from the state bucket. Only upper-case keys with plain values (what
# record_value writes for digests, IDs, addresses and suffixes) are accepted.
load_env_file() {
  local file="$1" line key value name="${1##*/}"
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    [[ "$line" == *=* && "$key" =~ ^[A-Z][A-Z0-9_]*$ && "$value" =~ ^[A-Za-z0-9._:/@+-]*$ ]] ||
      fail "${name} holds a record that is not a plain KEY=value"
    declare -g "${key}=${value}"
  done <"$file"
}

# The proof run record comes back from the state bucket, so it sets nothing
# but the queue suffix: when present it must be exactly one valid
# QUEUE_SUFFIX line, checked whole before anything is assigned.
load_proof_run_file() {
  [[ -f "$proof_run_file" ]] || return 0
  local -a lines
  mapfile -t lines < <(grep -v '^$' "$proof_run_file")
  ((${#lines[@]} == 1)) && [[ "${lines[0]}" =~ ^QUEUE_SUFFIX=(r[0-9]{1,20}-[0-9]{1,4})$ ]] ||
    fail "the proof run record is not exactly one valid QUEUE_SUFFIX"
  QUEUE_SUFFIX="${BASH_REMATCH[1]}"
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
  load_proof_run_file
  trace bun scripts/sandbox-stack-config.ts
  (
    cd "$package_dir"
    SANDBOX_PROJECT_ID="$project_id" \
      SANDBOX_PROJECT_NUMBER="${SANDBOX_EXPECTED_PROJECT_NUMBER}" \
      SANDBOX_REGION="$region" \
      SANDBOX_STATE_BUCKET="$state_bucket" \
      SANDBOX_TELEMETRY_COLLECTOR_DIGEST="$collector_digest" \
      SANDBOX_QUEUE_SUFFIX="${QUEUE_SUFFIX:-}" \
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

# `release status` into a named artifact file; prints the file path. Its
# stdout must be the one JSON record: logs go to stderr, and anything else
# fails here rather than reading as an absent lock.
release_status() {
  local file="${proof_dir}/status-$1.json"
  use_stack_config
  trace bun run release status
  if $dry_run; then
    printf '%s\n' "$dry_status" >"$file"
  else
    (cd "$package_dir" && bun release.run.ts status) >"$file" ||
      fail "release status failed; see $(basename "$file")"
    jq -se 'length == 1 and (.[0].record | type == "object")' "$file" >/dev/null 2>&1 ||
      fail "release status printed no single JSON record; see $(basename "$file")"
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

# `release plan` must report no changes. Alchemy's plan goes to stderr, with
# every log, so both streams are read.
expect_no_op_plan() {
  release plan 2>&1 | tee "$plan_log" >&2
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
# The wait is bounded by time, not by a count of attempts: the given
# seconds, else the serving timeout.
expect_serving() {
  local version="$1" timeout="${2:-$SANDBOX_SERVING_TIMEOUT_SECONDS}"
  local ip attempt=0 served=0 body deadline=$((SECONDS + timeout))
  ip="$(edge_ip)"
  trace curl -fsS "http://${ip}/healthz" "(x10, until version=${version})"
  $dry_run && return 0
  while ((SECONDS < deadline)); do
    attempt=$((attempt + 1))
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
  fail "the edge did not serve ${version} on every request within ${timeout} s (${served}/10)"
}

# One state-bucket object's live metadata from the Cloud Storage JSON API,
# as JSON with the requested fields, or "absent" only when the service
# answers 404 "No such object" for this very object. An authentication,
# transport or any other error fails, so an unreadable object never reads
# as a missing or unchanged one.
storage_object() {
  local name="$1" fields="$2" url response code body token
  url="https://storage.googleapis.com/storage/v1/b/${state_bucket}/o/$(jq -rn --arg name "$name" '$name | @uri')?fields=${fields}"
  token="$(gcloud auth print-access-token)" || return 1
  [[ -n "$token" ]] || return 1
  response="$(printf 'Authorization: Bearer %s\n' "$token" |
    curl -sS --max-time 30 -H @- -w '\n%{http_code}' "$url")" || return 1
  code="${response##*$'\n'}"
  body="${response%$'\n'*}"
  case "$code" in
    200)
      jq -ce . <<<"$body" 2>/dev/null || return 1
      ;;
    404)
      jq -e --arg object "${state_bucket}/${name}" \
        '.error.code == 404 and (.error.message == "No such object: \($object)")' \
        >/dev/null <<<"$body" 2>/dev/null || return 1
      echo absent
      ;;
    *) return 1 ;;
  esac
}

# An object's live generation, or "absent"; fails when unreadable.
object_generation() {
  local object generation
  trace curl -sS "https://storage.googleapis.com/storage/v1/b/${state_bucket}/o/<$1>?fields=generation" \
    "(bearer from gcloud, never printed)"
  if $dry_run; then
    echo 1
    return 0
  fi
  object="$(storage_object "$1" generation)" || return 1
  if [[ "$object" == absent ]]; then
    echo absent
    return 0
  fi
  generation="$(jq -r '.generation // empty' <<<"$object")"
  [[ "$generation" =~ ^[0-9]+$ ]] || return 1
  echo "$generation"
}

# No Alchemy lease holder: a live holder refreshes the 60 s lease well
# within a minute, so an unchanged generation over 65 s means none. An
# unreadable lease fails rather than counting as quiet.
wait_for_quiet_lease() {
  local before after
  before="$(object_generation "$lease_object")" ||
    fail "the Alchemy lease is unreadable; a live holder cannot be ruled out"
  pause 65
  after="$(object_generation "$lease_object")" ||
    fail "the Alchemy lease is unreadable; a live holder cannot be ruled out"
  expect_equal "Alchemy lease generation over 65 s" "$after" "$before"
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
  inventory_class "$dir" logging-exclusions project_exclusion_names
  inventory_class "$dir" logging-sinks gcloud logging sinks list "${p[@]}" --format='value(name,destination)'
  inventory_class "$dir" tasks-queues gcloud tasks queues list "${p[@]}" --location="$region" --format='value(name)'
  inventory_class "$dir" scheduler-jobs gcloud scheduler jobs list "${p[@]}" --location="$region" --format='value(name)'
  inventory_class "$dir" storage-buckets gcloud storage buckets list "${p[@]}" --format='value(name)'
  inventory_class "$dir" state-objects gcloud storage ls -r "gs://${state_bucket}/"
}

# What counts as a proof resource in each class. The shared state bucket,
# WIF, deployer and release record history are preserved by design and not
# matched.
proof_pattern() {
  case "$1" in
    run-services) echo '^workspace-' ;;
    # `value(name)` lists the bare repository ID.
    artifact-repositories) echo "(^|/repositories/)${artifact_repository}\$" ;;
    forwarding-rules | addresses | backend-services | url-maps | target-http-proxies | target-https-proxies | network-endpoint-groups | security-policies | ssl-certificates)
      echo "^workspace-${stage}-" ;;
    logging-exclusions) echo "^${edge_exclusion}\$" ;;
    # `value(name)` lists bare queue and job IDs.
    tasks-queues | scheduler-jobs) echo '(^|/)workspace-' ;;
    storage-buckets) echo "^(gs://)?${mobile_updates_bucket}/?\$" ;;
    # Objects only: `storage ls -r` also prints each folder as a
    # `gs://…/prefix/:` heading, which is no residue.
    state-objects) echo "${stack_prefix}[^_:][^:]*\$|/${proof_run_object}\$" ;;
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
  if [[ ! -f "$proof_run_file" ]] &&
    ! run gcloud storage cp "gs://${state_bucket}/${proof_run_object}" "$proof_run_file"; then
    notice "no recorded proof run; queue IDs come from Alchemy state alone"
  fi
  load_env_file "$digests_file"
  write_stack_config "${COLLECTOR_DIGEST:-}"
  check_teardown_window
}

# The stack config's teardown deadline bounds the proof: hosted-proof must
# start at least a day before it; cleanup-only runs at any time.
check_teardown_window() {
  local teardown_at deadline now latest_start
  teardown_at="$(jq -r '.budget.teardownAt // empty' "$stack_config_file")"
  [[ -n "$teardown_at" ]] || fail "the sandbox stack config records no teardown deadline"
  deadline="$(date -u -d "$teardown_at" +%s)" || fail "unreadable teardown deadline ${teardown_at}"
  now="$(date -u +%s)"
  latest_start=$((deadline - hosted_proof_teardown_margin_seconds))
  if [[ "${SANDBOX_PROOF_MODE:-}" == hosted-proof ]] && ((now > latest_start)); then
    fail "hosted-proof must start by $(date -u -d "@${latest_start}" +%Y-%m-%dT%H:%M:%SZ), a day before the ${teardown_at} teardown deadline; only cleanup-only may run now"
  fi
  if ((now > deadline)); then
    warning "the ${teardown_at} teardown deadline has passed; tear the sandbox down"
  fi
  echo "teardown deadline ${teardown_at}; ${SANDBOX_PROOF_MODE:-this mode} may run"
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
  local exclusions
  if exclusions="$(project_exclusions_json)"; then
    $dry_run || jq -r '.[] | [.name, (.disabled // false), .filter] | @tsv' <<<"$exclusions"
  else
    notice "log exclusions unverified (denied)"
  fi
}

phase_baseline_inventory() {
  take_inventory baseline
}

phase_foundation() {
  # Cloud Tasks keeps a deleted queue's ID unavailable for days, so every
  # proof run declares queues of its own, recorded before Alchemy creates
  # any for cleanup and recovery.
  record_value "$proof_run_file" QUEUE_SUFFIX "r${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
  run gcloud storage cp "$proof_run_file" "gs://${state_bucket}/${proof_run_object}"
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

# Both backends enforce the stack's Cloud Armor policy, with the sandbox's
# WAF rules in preview and the auth throttle enforced.
verify_edge_security() {
  local backend attached rules
  for backend in "${edge_backend_services[@]}"; do
    attached="$(capture "projects/${project_id}/global/securityPolicies/${edge_security_policy}" \
      gcloud compute backend-services describe "$backend" --global --project="$project_id" \
      --format='value(securityPolicy)')" ||
      fail "backend service ${backend} is unreadable; its Cloud Armor policy is unverified"
    expect_equal "${backend} Cloud Armor policy" "${attached##*/}" "$edge_security_policy"
  done
  rules="$(capture '{"rules":[]}' gcloud compute security-policies describe "$edge_security_policy" \
    --project="$project_id" --format='json(rules)')" ||
    fail "Cloud Armor policy ${edge_security_policy} is unreadable"
  if $dry_run; then
    echo "  expect the declared SQLi and XSS rules in preview and the auth throttle enforced" >&2
    return 0
  fi
  # Each rule as the stack declares it for the sandbox: matcher, action,
  # preview and the auth throttle's limit.
  jq -e --arg sqli "evaluatePreconfiguredWaf('sqli-v33-stable', {'sensitivity': 1})" \
    --arg xss "evaluatePreconfiguredWaf('xss-v33-stable', {'sensitivity': 1})" \
    --arg auth "request.path.startsWith('/api/auth/')" \
    --argjson limit "$edge_auth_rate_limit" '
    def rule($priority): [.rules[]? | select(.priority == $priority)] | select(length == 1) | .[0];
    def waf($priority; $expression):
      rule($priority) | .action == "deny(403)" and .preview == true
        and .match.expr.expression == $expression;
    [waf(1000; $sqli), waf(1010; $xss),
      (rule(2000) | .action == "throttle" and .preview != true
        and .match.expr.expression == $auth
        and .rateLimitOptions.conformAction == "allow"
        and .rateLimitOptions.exceedAction == "deny(429)"
        and .rateLimitOptions.enforceOnKey == "IP"
        and .rateLimitOptions.rateLimitThreshold.count == $limit
        and .rateLimitOptions.rateLimitThreshold.intervalSec == 60)]
    | length == 3 and all' >/dev/null <<<"$rules" ||
    fail "Cloud Armor policy ${edge_security_policy} does not hold the declared WAF preview rules and auth throttle"
  echo "both backends enforce ${edge_security_policy}: WAF rules in preview, auth throttle enforced"
}

# The edge the stack config declares, from the package's own declarations:
# protocol, physical object names and the token-route exclusion filter.
declared_edge() {
  use_stack_config
  trace bun scripts/sandbox-edge-declaration.ts
  if $dry_run; then
    jq -cn --arg filter "$dry_run_exclusion_filter" --arg policy "$edge_security_policy" \
      --arg dynamic "${edge_backend_services[0]}" --arg static "${edge_backend_services[1]}" \
      --arg exclusion "$edge_exclusion" '{protocol: "http",
        names: {address: "workspace-sandbox-edge", securityPolicy: $policy,
          dynamicBackend: $dynamic, staticBackend: $static, urlMap: "workspace-sandbox-edge",
          httpProxy: "workspace-sandbox-edge-http", httpForwardingRule: "workspace-sandbox-http",
          tokenRouteExclusion: $exclusion},
        tokenRouteExclusionFilter: $filter}'
  else
    (cd "$package_dir" && bun scripts/sandbox-edge-declaration.ts)
  fi
}

# One declared edge object's physical name.
declared_edge_name() {
  jq -r --arg key "$2" '.names[$key] // empty' "$1"
}

# deliver-v1 declared the edge with the first release, in the same locked
# apply. The live state holds no stack outputs object (run 45279064237
# found only per-resource state), so the edge is read back live by
# the names the stack declares: the address's IP, the HTTP forwarding rule
# on it, its proxy and URL map. Reading back writes nothing. The web service
# only admits load-balancer traffic (ingress INTERNAL_LOAD_BALANCER), so
# every HTTP check goes through this edge.
phase_edge_readback() {
  local declared="${proof_dir}/edge-declaration.json"
  declared_edge >"$declared" ||
    fail "the stack config's edge declaration is unreadable"
  jq -e 'type == "object"' "$declared" >/dev/null 2>&1 ||
    fail "the stack config declares no edge; deliver-v1 must declare it"
  expect_equal "edge protocol" "$(jq -r '.protocol' "$declared")" http
  expect_equal "edge Cloud Armor policy" "$(declared_edge_name "$declared" securityPolicy)" "$edge_security_policy"
  expect_equal "edge dynamic backend" "$(declared_edge_name "$declared" dynamicBackend)" "${edge_backend_services[0]}"
  expect_equal "edge static backend" "$(declared_edge_name "$declared" staticBackend)" "${edge_backend_services[1]}"
  expect_equal "edge token-route exclusion" "$(declared_edge_name "$declared" tokenRouteExclusion)" "$edge_exclusion"
  local p=(--project="$project_id" --global) ip rule target url_map
  ip="$(capture 198.51.100.10 gcloud compute addresses describe "$(declared_edge_name "$declared" address)" "${p[@]}" \
    --format='value(address)')" ||
    fail "the edge address $(declared_edge_name "$declared" address) is unreadable; deliver-v1 must declare the edge"
  [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] ||
    fail "the edge address $(declared_edge_name "$declared" address) holds no IPv4 address"
  rule="$(capture "{\"IPAddress\":\"${ip}\",\"portRange\":\"80-80\",\"target\":\"targetHttpProxies/$(declared_edge_name "$declared" httpProxy)\"}" \
    gcloud compute forwarding-rules describe "$(declared_edge_name "$declared" httpForwardingRule)" "${p[@]}" \
    --format='json(IPAddress,portRange,target)')" ||
    fail "the edge forwarding rule $(declared_edge_name "$declared" httpForwardingRule) is unreadable"
  expect_equal "edge forwarding rule address" "$(jq -r '.IPAddress // empty' <<<"$rule")" "$ip"
  # Compute reports a single port as `80-80`; `80` means the same.
  local port
  port="$(jq -r '.portRange // empty' <<<"$rule")"
  [[ "$port" == 80 ]] && port=80-80
  expect_equal "edge forwarding rule port" "$port" 80-80
  target="$(jq -r '.target // empty' <<<"$rule")"
  expect_equal "edge forwarding rule target" "${target##*/targetHttpProxies/}" "$(declared_edge_name "$declared" httpProxy)"
  url_map="$(capture "urlMaps/$(declared_edge_name "$declared" urlMap)" gcloud compute target-http-proxies describe \
    "$(declared_edge_name "$declared" httpProxy)" "${p[@]}" --format='value(urlMap)')" ||
    fail "the edge proxy $(declared_edge_name "$declared" httpProxy) is unreadable"
  expect_equal "edge proxy URL map" "${url_map##*/urlMaps/}" "$(declared_edge_name "$declared" urlMap)"
  # The edge as read back, for the proof artifact; no other stack value.
  jq --arg ip "$ip" '{edgeIpAddress: $ip, edgeProtocol: .protocol,
    securityPolicy: .names.securityPolicy,
    backendServices: {dynamic: .names.dynamicBackend, static: .names.staticBackend},
    tokenRouteExclusionFilter}' "$declared" >"$edge_outputs_file"
  record_value "$edge_file" EDGE_IP "$ip"
  # The declared filter's exact bytes, with no newline added: what the
  # privacy phase requires the live exclusion to apply.
  jq -j '.tokenRouteExclusionFilter // empty' "$declared" >"$exclusion_filter_file"
  [[ -s "$exclusion_filter_file" ]] ||
    fail "the edge declares no token-route exclusion filter"
  verify_edge_security
  expect_serving v1 "$SANDBOX_FIRST_SERVING_TIMEOUT_SECONDS"
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

# The persisted Cloud Run generation of every release service.
# Each release service's persisted Cloud Run generation, one per line in
# release_services order; fails when any read fails or is not a number.
release_service_generations() {
  local service generation
  for service in "${release_services[@]}"; do
    generation="$(capture 1 gcloud run services describe "$service" --project="$project_id" \
      --region="$region" --format='value(metadata.generation)' 2>/dev/null)" || return 1
    [[ "$generation" =~ ^[0-9]+$ ]] || return 1
    printf '%s\n' "$generation"
  done
}

# Whether some service's generation rose between two successful reads.
generations_increased() {
  local -a before after
  local index
  mapfile -t before <<<"$1"
  mapfile -t after <<<"$2"
  ((${#before[@]} == ${#release_services[@]} && ${#after[@]} == ${#release_services[@]})) || return 1
  for index in "${!release_services[@]}"; do
    ((after[index] > before[index])) && return 0
  done
  return 1
}

# Processes whose environment carries the interrupt token. Every descendant
# of the interrupted deliver inherits it, including the Alchemy child Bun's
# spawner moves into its own session and any process reparented after its
# parent died. A reaped or zombie process has no environment and drops out.
token_processes() {
  local token="$1" environ pid
  for environ in /proc/[0-9]*/environ; do
    pid="${environ#/proc/}"
    pid="${pid%/environ}"
    if grep -qzx "SANDBOX_PROOF_INTERRUPT_TOKEN=${token}" "$environ" 2>/dev/null; then
      printf '%s\n' "$pid"
    fi
  done
  return 0
}

# The writer-lock fingerprint of a token process's release writer: the
# lock holder is the first 12 hex digits of the SHA-256 of the writer token
# the deliver hands its Alchemy apply. The token itself is never printed.
token_writer_fingerprint() {
  local token="$1" pid writer
  while IFS= read -r pid; do
    writer="$(tr '\0' '\n' <"/proc/${pid}/environ" 2>/dev/null |
      sed -n 's/^WORKSPACE_RELEASE_WRITER=//p' | head -n 1)"
    if [[ -n "$writer" ]]; then
      printf '%s' "$writer" | sha256sum | cut -c1-12
      return 0
    fi
  done < <(token_processes "$token")
  return 1
}

# Stop, then kill, every token process until none remain; stopping first
# keeps one from forking a replacement. Fails if any survive.
kill_token_processes() {
  local token="$1" pids
  for _ in $(seq 1 50); do
    mapfile -t pids < <(token_processes "$token")
    ((${#pids[@]} == 0)) && return 0
    kill -STOP "${pids[@]}" 2>/dev/null || true
    kill -KILL "${pids[@]}" 2>/dev/null || true
    sleep 0.2
  done
  mapfile -t pids < <(token_processes "$token")
  ((${#pids[@]} == 0))
}

# Kill an in-flight `release deliver` once its Alchemy apply has persisted a
# Cloud Run change, with every process it started, then recover: once the
# Alchemy lease is quiet the confirmed-dead holder is cleared with
# `release unlock --holder` (the writer lock has no expiry), any pending
# traffic change is settled by `release recover`, and the deliver is rerun.
phase_interrupt_recover() {
  load_env_file "$digests_file"
  expect_settled "$(release_status before-interrupt)"
  local before after log="${proof_dir}/interrupted-deliver.log"
  before="$(release_service_generations)" ||
    fail "Cloud Run service generations are unreadable; the interrupt has no baseline"
  use_stack_config
  trace env "SANDBOX_PROOF_INTERRUPT_TOKEN=<random>" bun run release deliver \
    --sha "$GITHUB_SHA" --image-digest "${PROBE_V3_DIGEST:-}" "&"
  if ! $dry_run; then
    local token pid changed=false running fingerprint="" deadline=$((SECONDS + 900))
    token="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
    (cd "$package_dir" && exec env "SANDBOX_PROOF_INTERRUPT_TOKEN=${token}" bun release.run.ts \
      deliver --sha "$GITHUB_SHA" --image-digest "$PROBE_V3_DIGEST") >"$log" 2>&1 &
    pid=$!
    # The token is in place once `env` has executed; a deliver that has
    # already ended never shows it.
    for _ in $(seq 1 100); do
      [[ -n "$(token_processes "$token")" ]] && break
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    # `kill -0` would still see an exited, unreaped deliver; the token does not.
    while ((SECONDS < deadline)) && [[ -n "$(token_processes "$token")" ]]; do
      # The deliver's own lock, read from its apply while it still runs.
      [[ -n "$fingerprint" ]] || fingerprint="$(token_writer_fingerprint "$token")" || true
      # A failed read is inconclusive: only a read generation increase counts.
      if after="$(release_service_generations)" && generations_increased "$before" "$after"; then
        changed=true
        break
      fi
      sleep 1
    done
    [[ -n "$fingerprint" ]] || fingerprint="$(token_writer_fingerprint "$token")" || true
    running="$(token_processes "$token")"
    kill_token_processes "$token" ||
      fail "processes of the interrupted deliver survived SIGKILL: $(token_processes "$token" | tr '\n' ' ')"
    wait "$pid" 2>/dev/null || true
    $changed || fail "the deliver persisted no Cloud Run change before it ended; nothing was interrupted"
    [[ -n "$running" ]] || fail "the deliver had exited when its change was seen; nothing was interrupted"
    [[ "$fingerprint" =~ ^[0-9a-f]{12}$ ]] ||
      fail "the interrupted deliver's writer lock was never identified; its lock stays for an operator"
    echo "killed the deliver after a persisted Cloud Run change; all its processes have exited"
  fi
  # A live Alchemy holder refreshes its lease; a quiet one has expired.
  wait_for_quiet_lease
  local status holder
  status="$(release_status interrupted)"
  holder="$(json_get '.record.writer.holder' "$status")"
  [[ -n "$holder" && "$holder" != null ]] || fail "the interrupted deliver left no writer lock"
  # Only the killed deliver's own lock is proven dead; another writer may
  # have taken the lock since, and teardown may clear no other.
  if ! $dry_run; then
    [[ "$holder" == "$fingerprint" ]] ||
      fail "the writer lock is held by ${holder}, not the killed deliver (${fingerprint}); it stays for an operator"
    printf '%s\n' "$holder" >"$dead_holder_file"
  fi
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

# One live generation and CRC32C per Alchemy state object of the stack,
# lease excluded, sorted by name. A listing may also return noncurrent
# generations, so it only supplies names; each object is then described,
# which reads its live generation alone.
live_state_manifest() {
  local out="$1" names name described count
  names="$(gcloud storage objects list "gs://${state_bucket}/${stack_prefix}**" --format='value(name)')" ||
    fail "the stack's state objects are unreadable"
  : >"${out}.rows"
  count=0
  while IFS= read -r name; do
    [[ -z "$name" || "$name" == "$lease_object" ]] && continue
    # Only a name the service confirms has no live object is skipped
    # (noncurrent history); any other unreadable object fails the manifest
    # before a snapshot is accepted or a restore writes anything.
    described="$(storage_object "$name" name,generation,crc32c)" ||
      fail "state object ${name} is unreadable"
    [[ "$described" == absent ]] && continue
    jq -c --arg name "$name" \
      'select(.name == $name and (.generation | tostring | test("^[0-9]+$")) and (.crc32c // "") != "")
        | {name, generation: (.generation | tostring), crc32c}' \
      <<<"$described" >>"${out}.rows"
    count=$((count + 1))
  done < <(sort -u <<<"$names")
  jq -s 'sort_by(.name)' "${out}.rows" >"$out"
  rm -f "${out}.rows"
  [[ "$(jq 'length' "$out")" == "$count" ]] ||
    fail "a state object described without its own name, generation or CRC32C"
}

# Internal phases the writer-lock holder runs (sandbox-locked-stack.ts
# state-snapshot | state-restore); never called directly.
require_writer_lock() {
  [[ -n "${WORKSPACE_RELEASE_WRITER:-}" ]] || fail "$1 runs only under the writer lock"
}

phase_state_snapshot_locked() {
  require_writer_lock state-snapshot-locked
  live_state_manifest "${proof_dir}/state-live.json"
}

# Copy each snapshot generation back where the live one differs and remove
# objects the snapshot lacks, each guarded by the live generation just read,
# then require the live objects to match the snapshot's names and CRC32C.
phase_state_restore_locked() {
  require_writer_lock state-restore-locked
  local snapshot="${proof_dir}/state-snapshot.json" current="${proof_dir}/state-before-restore.json"
  [[ -s "$snapshot" ]] || fail "no state snapshot to restore"
  live_state_manifest "$current"
  local name wanted live
  while IFS=$'\t' read -r name wanted; do
    live="$(jq -r --arg name "$name" '.[] | select(.name == $name) | .generation' "$current")"
    [[ "$live" == "$wanted" ]] && continue
    run gcloud storage cp "gs://${state_bucket}/${name}#${wanted}" "gs://${state_bucket}/${name}" \
      --if-generation-match="${live:-0}"
  done < <(jq -r '.[] | [.name, .generation] | @tsv' "$snapshot")
  while IFS=$'\t' read -r name live; do
    run gcloud storage rm "gs://${state_bucket}/${name}" --if-generation-match="$live"
  done < <(jq -r --slurpfile snapshot "$snapshot" \
    '($snapshot[0] | map(.name)) as $kept | .[] | select(.name as $n | $kept | index($n) | not) | [.name, .generation] | @tsv' \
    "$current")
  live_state_manifest "${proof_dir}/state-restored.json"
  jq -e --slurpfile snapshot "$snapshot" \
    'map({name, crc32c}) == ($snapshot[0] | map({name, crc32c}))' \
    "${proof_dir}/state-restored.json" >/dev/null ||
    fail "the live state objects do not match the snapshot"
  echo "live Alchemy state matches the snapshot object for object"
}

# The live state manifest, read under the writer lock, into a named file.
locked_state_manifest() {
  locked_stack state-snapshot
  $dry_run || cp "${proof_dir}/state-live.json" "${proof_dir}/$1"
}

# Snapshot the stack's live Alchemy state, make a tracked change (restore
# traffic to v2), restore the snapshot and reconcile. Snapshot and restore
# each hold the writer lock, after the Alchemy lease has gone quiet.
phase_state_snapshot_restore() {
  load_env_file "$releases_file"
  expect_settled "$(release_status before-snapshot)"
  wait_for_quiet_lease
  locked_state_manifest state-snapshot.json

  local status generation
  status="$(release_status before-tracked-change)"
  generation="$(json_require '.record.generation' "$status")"
  release restore --release-id "${V2_RELEASE_ID:-}" --expected-generation "$generation"
  expect_serving v2

  expect_settled "$(release_status after-tracked-change)"
  wait_for_quiet_lease
  locked_state_manifest state-changed.json
  if ! $dry_run; then
    jq -e --slurpfile before "${proof_dir}/state-snapshot.json" '. != $before[0]' \
      "${proof_dir}/state-changed.json" >/dev/null ||
      fail "the tracked change wrote no Alchemy state object"
  fi

  locked_stack state-restore
  echo "Alchemy state restored to the snapshot"

  release deploy
  expect_no_op_plan
  expect_settled "$(release_status after-state-restore)"
  expect_serving v2
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

# Every enabled sink that receives this project's logs must drop
# token-route request logs before a marker is sent: the project's own sinks
# and any folder or organization sink that includes or intercepts its
# children. _Default is covered by the stack's project exclusion, every
# other sink by an enabled sink exclusion with the same filter. _Required
# carries only audit logs and cannot be changed. An unreadable level, or a
# sink whose filter could match without that exclusion, fails the proof.
verify_log_routing() {
  local dir="${proof_dir}/log-routing" exclusions ancestors sinks id type
  mkdir -p "$dir"
  exclusions="$(project_exclusions_json)" ||
    fail "project log exclusions are unreadable; log routing unverified"
  printf '%s\n' "$exclusions" >"${dir}/project-exclusions.json"
  ancestors="$(capture "[{\"id\":\"${project_id}\",\"type\":\"project\"}]" \
    gcloud projects get-ancestors "$project_id" --format=json)" ||
    fail "the project's folders and organization are unreadable; inherited sinks unverified"
  sinks="$(capture '[]' gcloud logging sinks list --project="$project_id" --format=json)" ||
    fail "project log sinks are unreadable; log routing unverified"
  if $dry_run; then
    trace gcloud logging sinks list "--folder=<each ancestor folder>" --format=json
    trace gcloud logging sinks list "--organization=<ancestor organization>" --format=json
    echo "  expect every enabled project and inherited sink to exclude ${edge_exclusion}'s filter" >&2
    return 0
  fi
  jq --arg parent "projects/${project_id}" '[.[] | . + {parent: $parent, level: "project"}]' \
    <<<"$sinks" >"${dir}/sinks.json"
  while IFS=$'\t' read -r id type; do
    case "$type" in
      project) continue ;;
      folder | organization) ;;
      *) fail "unknown ancestor type ${type}; inherited sinks unverified" ;;
    esac
    sinks="$(gcloud logging sinks list "--${type}=${id}" --format=json)" ||
      fail "${type} ${id} log sinks are unreadable; inherited sinks unverified"
    jq --arg parent "${type}s/${id}" --slurpfile known "${dir}/sinks.json" \
      '$known[0] + [.[] | . + {parent: $parent, level: "ancestor"}]' <<<"$sinks" >"${dir}/sinks.next"
    mv "${dir}/sinks.next" "${dir}/sinks.json"
  done < <(jq -r '.[] | [.id, .type] | @tsv' <<<"$ancestors")
  # The live project exclusion must be the filter the stack declares, and
  # that filter must name both request sources and every token route.
  local expected source route
  expected="$(cat "$exclusion_filter_file" 2>/dev/null)" ||
    fail "the edge recorded no token-route exclusion filter; log routing unverified"
  [[ -n "$expected" ]] || fail "the edge recorded an empty token-route exclusion filter"
  for source in "${token_request_sources[@]}"; do
    [[ "$expected" == *"$source"* ]] || fail "the token-route exclusion filter omits ${source}"
  done
  for route in "${token_routes[@]}"; do
    [[ "$expected" == *"$route"* ]] || fail "the token-route exclusion filter omits ${route}"
  done
  # Compared as decoded strings: command substitution would strip a
  # trailing newline from either side.
  jq -e --arg name "$edge_exclusion" --rawfile expected "$exclusion_filter_file" \
    'map(select(.name == $name and .disabled != true)) | first | .filter == $expected' \
    "${dir}/project-exclusions.json" >/dev/null ||
    fail "the enabled project exclusion ${edge_exclusion} does not apply the stack's token-route filter"
  local uncovered
  uncovered="$(jq -r --arg name "$edge_exclusion" --slurpfile exclusions "${dir}/project-exclusions.json" '
    ($exclusions[0] | map(select(.name == $name and .disabled != true)) | first | .filter) as $filter
    | if $filter == "" or $filter == null then "missing enabled project exclusion \($name)"
      else .[]
        | select(.disabled != true)
        | select(.level == "project" or .includeChildren == true or .interceptChildren == true)
        | select(.level != "project" or (.name != "_Required" and .name != "_Default"))
        | select([.exclusions[]? | select(.disabled != true and .filter == $filter)] | length == 0)
        | "\(.parent) sink \(.name) -> \(.destination)"
      end' "${dir}/sinks.json")"
  [[ -z "$uncovered" ]] ||
    fail "token-route request logs could reach: $(tr '\n' ';' <<<"$uncovered")"
  echo "every project and inherited log sink drops token-route request logs"
}

# The probe's current OTLP export: its trace ID must name a structured log
# line from this service and a Cloud Trace trace holding the synthetic span.
# A missing, empty or unreadable answer fails the proof.
verify_probe_telemetry() {
  local ip body trace_id="" status="" attempt
  ip="$(edge_ip)"
  for attempt in $(seq 1 10); do
    body="$(capture '{"otlp":{"traceId":"0123456789abcdef0123456789abcdef","status":200}}' \
      curl -fsS --max-time 10 "http://${ip}/healthz" 2>/dev/null || true)"
    trace_id="$(jq -r '.otlp.traceId // empty' <<<"$body" 2>/dev/null || true)"
    status="$(jq -r '.otlp.status // empty' <<<"$body" 2>/dev/null || true)"
    [[ "$trace_id" =~ ^[0-9a-f]{32}$ && "$status" =~ ^2[0-9][0-9]$ ]] && break
    $dry_run && break
    pause 10
  done
  [[ "$trace_id" =~ ^[0-9a-f]{32}$ && "$status" =~ ^2[0-9][0-9]$ ]] ||
    fail "the probe reports no accepted OTLP export (trace '${trace_id}', status '${status}')"
  echo "probe exported synthetic trace ${trace_id} (collector status ${status})"

  local entries="" found=false
  for attempt in $(seq 1 12); do
    if entries="$(capture '[{}]' gcloud logging read \
      "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${web_service}\" AND jsonPayload.otlp.traceId=\"${trace_id}\"" \
      --project="$project_id" --freshness=1h --limit=1 --format='json(timestamp,jsonPayload.otlp)')"; then
      [[ "$(jq 'length' <<<"$entries")" != 0 ]] && {
        found=true
        break
      }
    else
      fail "Cloud Logging is unreadable; the probe's structured log is unverified"
    fi
    $dry_run && break
    pause 15
  done
  $found || fail "no structured probe log for trace ${trace_id}"
  echo "structured probe log present for trace ${trace_id}"

  local trace_body="" spans=0
  for attempt in $(seq 1 12); do
    if trace_body="$(google_get '{"spans":[{"name":"sandbox-probe.synthetic"}]}' \
      "https://cloudtrace.googleapis.com/v1/projects/${project_id}/traces/${trace_id}")"; then
      spans="$(jq '[.spans[]? | select(.name == "sandbox-probe.synthetic")] | length' <<<"$trace_body")"
      ((spans > 0)) && break
    fi
    $dry_run && break
    pause 15
  done
  ((spans > 0)) ||
    fail "Cloud Trace returned no sandbox-probe.synthetic span for trace ${trace_id} (denied, empty or not ingested)"
  echo "Cloud Trace holds the probe's synthetic span for trace ${trace_id}"
  record_value "${proof_dir}/telemetry.env" PROBE_TRACE_ID "$trace_id"
}

# Token-route requests carry a synthetic marker; it must reach no
# searchable log or readable trace. Routing is verified first, request
# logs for other routes must be readable (the control), and any unreadable
# source fails the proof rather than counting as clean.
phase_edge_privacy() {
  verify_log_routing
  verify_probe_telemetry
  local ip path body start
  ip="$(edge_ip)"
  start="$(capture 2026-01-01T00:00:00Z date -u +%Y-%m-%dT%H:%M:%SZ)"
  for path in "${token_routes[@]}"; do
    body="$(capture "{\"route\":\"${path}\"}" curl -fsS --max-time 10 "http://${ip}${path}?token=${marker}")"
    [[ "$body" != *"$marker"* ]] || fail "${path} echoed the marker"
  done
  capture '{}' curl -fsS --max-time 10 "http://${ip}/healthz" >/dev/null
  pause 90

  local requests="" attempt control=false
  for attempt in $(seq 1 8); do
    requests="$(capture '[{}]' gcloud logging read \
      "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${web_service}\" AND log_id(\"run.googleapis.com/requests\") AND timestamp>=\"${start}\"" \
      --project="$project_id" --freshness=1h --limit=1 --format='json(timestamp)')" ||
      fail "Cloud Run request logs are unreadable; marker absence unverified"
    [[ "$(jq 'length' <<<"$requests")" != 0 ]] && {
      control=true
      break
    }
    $dry_run && break
    pause 15
  done
  $control || fail "no Cloud Run request log since ${start}; marker absence would prove nothing"

  local logs
  logs="$(capture '[]' gcloud logging read "\"${marker}\"" --project="$project_id" \
    --freshness=1h --limit=20 --format='json(logName,timestamp)')" ||
    fail "Cloud Logging is unreadable; marker absence in logs unverified"
  [[ "$(jq 'length' <<<"$logs")" == 0 ]] ||
    fail "the marker reached readable logs: $(jq -c '[.[] | .logName]' <<<"$logs")"
  echo "marker absent from searchable Cloud Logging entries"

  # Every trace of the last hour, which must include the probe's own.
  load_env_file "${proof_dir}/telemetry.env"
  local window traces page="" listed=false
  window="$(capture 2026-01-01T00:00:00Z date -u -d '-1 hour' +%Y-%m-%dT%H:%M:%SZ)"
  for _ in $(seq 1 20); do
    traces="$(google_get '{"traces":[{"traceId":"0123456789abcdef0123456789abcdef"}]}' \
      "https://cloudtrace.googleapis.com/v1/projects/${project_id}/traces?view=COMPLETE&pageSize=100&startTime=${window}${page:+&pageToken=${page}}")" ||
      fail "Cloud Trace is unreadable; marker absence in traces unverified"
    [[ "$traces" != *"$marker"* ]] || fail "the marker reached Cloud Trace"
    jq -e --arg id "${PROBE_TRACE_ID:-}" 'any(.traces[]?; .traceId == $id)' >/dev/null <<<"$traces" &&
      listed=true
    page="$(jq -r '.nextPageToken // empty' <<<"$traces")"
    [[ -z "$page" ]] && break
  done
  [[ -z "$page" ]] || fail "more than 20 pages of traces; marker absence unverified"
  $dry_run || $listed || fail "the trace listing omits the probe's trace; marker absence unverified"
  echo "marker absent from every Cloud Trace span of the last hour"
}

# Scoped destroy of exactly the sandbox stack, edge included, under the
# writer lock. Alchemy removes the edge before the web service its endpoint
# group names. The state bucket, WIF and deployer stay; the release record's
# live object and the proof run record are removed so the next proof starts
# empty, and their generations stay as noncurrent history in the versioned
# bucket. A refused lock or a failed destroy stops here: nothing is ever
# deleted outside the lock, and the stack state is left for an operator.
phase_stack_destroy() {
  local status="" holder=""
  # The locked destroy takes the writer lock itself and refuses a held one,
  # so an unreadable status only skips clearing a proven-dead holder; it
  # never stops the teardown.
  if status="$(release_status before-destroy)"; then
    holder="$(json_get '.record.writer.holder' "$status")"
  else
    warning "the release status is unreadable; the locked destroy decides on the writer lock"
    status=""
  fi
  if ! $dry_run && [[ -n "$holder" && "$holder" != null ]]; then
    # Only the holder whose whole process tree the interrupt phase proved
    # dead may be cleared, and only once the Alchemy lease is quiet; any
    # other holder may still be writing, so its lock stays for an operator.
    [[ -f "$dead_holder_file" && "$(cat "$dead_holder_file")" == "$holder" ]] ||
      fail "the writer lock is held by ${holder}, whose death this run did not establish; the lock stays and nothing was destroyed (an operator must confirm it stopped)"
    wait_for_quiet_lease
    release unlock --holder "$holder" ||
      fail "the writer lock held by ${holder} was not released; nothing was destroyed"
    status="$(release_status destroy-unlocked)"
  fi
  if ! $dry_run && [[ -n "$status" && "$(json_get '.record.pendingApply' "$status")" != null ]]; then
    release recover || warning "recover failed; destroy may refuse the pending apply"
  fi
  locked_stack destroy ||
    fail "the locked Alchemy destroy failed or its lock was refused; nothing was deleted outside the lock, and the stack state under ${stack_prefix} needs an operator (rerun cleanup-only)"
  run gcloud storage rm "gs://${state_bucket}/${record_object}" ||
    warning "the release record's live object could not be removed"
  run gcloud storage rm "gs://${state_bucket}/${proof_run_object}" ||
    warning "the proof run record could not be removed"
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
    # Inventories list with gcloud alone, so a token problem never hides
    # what a failed teardown left behind.
    guard | readonly-inventory | baseline-inventory | post-destroy-inventory | state-snapshot-locked | state-restore-locked) ;;
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
    edge-readback) phase_edge_readback ;;
    deliver-v2) phase_deliver_v2 ;;
    drift) phase_drift ;;
    interrupt-recover) phase_interrupt_recover ;;
    state-snapshot-restore) phase_state_snapshot_restore ;;
    state-snapshot-locked) phase_state_snapshot_locked ;;
    state-restore-locked) phase_state_restore_locked ;;
    restore-v1) phase_restore_v1 ;;
    edge-privacy) phase_edge_privacy ;;
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
