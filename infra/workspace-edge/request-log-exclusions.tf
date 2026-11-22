# Drop raw request logs for routes whose URLs carry one-time tokens, before
# any Log Router sink stores them (#1453). Load balancer and Cloud Run
# request logs both record the full request URL.

locals {
  workspace_locales = ["en-US", "cs-CZ", "de-DE", "uk-UA", "sk-SK", "vi-VN", "hi-IN"]

  token_route_patterns = [
    "/app/auth/callback",
    "/api/auth/magic-link/verify",
    "(/(${join("|", local.workspace_locales)}))?/marketing-preferences/access",
  ]

  request_log_sources = "(resource.type=\"http_load_balancer\" OR (resource.type=\"cloud_run_revision\" AND log_id(\"run.googleapis.com/requests\")))"
}

resource "google_logging_project_exclusion" "token_route_requests" {
  name        = "workspace-${var.stage}-token-route-requests"
  description = "Raw request logs for token-bearing Workspace routes"
  filter = join(" AND ", [
    local.request_log_sources,
    "httpRequest.requestUrl=~\"^https?://[^/]+(${join("|", local.token_route_patterns)})([/?#]|$)\"",
  ])
}
