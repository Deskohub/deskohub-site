# Drop raw request logs for routes whose URLs carry one-time tokens
# (#1453). A project exclusion applies to the _Default sink only: it does
# not cover the _Required sink, other sinks, or logs inherited by folder and
# organization sinks, which the hosted proof checks separately. Load
# balancer and Cloud Run request logs both record the full request URL.

locals {
  # Any BCP 47 locale prefix the router may add, so a new locale is covered
  # without editing this list.
  locale_prefix = "(/[a-z]{2,3}-[A-Z]{2})?"

  token_route_patterns = [
    "/app/auth/callback",
    "/api/auth/magic-link/verify",
    "/api/email-campaigns/unsubscribe",
    "${local.locale_prefix}/marketing-preferences/access",
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
