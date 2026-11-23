# The Workspace OpenTelemetry collector sidecar: Google-Built otelcol-google
# 0.165.1, pinned by digest, with the Cloud Run config baked in. Build context:
# the repository root.
#   docker build -f packages/workspace-infrastructure/sandbox-probe/collector.Dockerfile .
#
# The base image runs `/otelcol-google --feature-gates=...` as user 10001
# with `--config=/etc/otelcol-google/config.yaml`; both stay inherited.
FROM us-docker.pkg.dev/cloud-ops-agents-artifacts/google-cloud-opentelemetry-collector/otelcol-google:0.165.1@sha256:8cdd5c85128a7f0b73710761487ee747ff9eadc7d7c090d91873aa3fdc1663cd

COPY apps/deskohub-workspace/otel-collector.cloudrun.yaml /etc/otelcol-google/config.yaml
