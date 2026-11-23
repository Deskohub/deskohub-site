# Starter Cloud Armor policy (#1453). WAF rules start in preview so their
# matches can be reviewed against real traffic before they block.

resource "google_compute_security_policy" "workspace" {
  name        = "workspace-${var.stage}-edge"
  description = "Workspace ${var.stage} edge policy"
  type        = "CLOUD_ARMOR"

  rule {
    action      = "deny(403)"
    priority    = 1000
    preview     = var.waf_preview
    description = "Preconfigured SQL injection rules"

    match {
      expr {
        expression = "evaluatePreconfiguredWaf('sqli-v33-stable', {'sensitivity': 1})"
      }
    }
  }

  rule {
    action      = "deny(403)"
    priority    = 1010
    preview     = var.waf_preview
    description = "Preconfigured cross-site scripting rules"

    match {
      expr {
        expression = "evaluatePreconfiguredWaf('xss-v33-stable', {'sensitivity': 1})"
      }
    }
  }

  rule {
    action      = "throttle"
    priority    = 2000
    description = "Throttle auth endpoints per client IP"

    match {
      expr {
        expression = "request.path.startsWith('/api/auth/')"
      }
    }

    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      enforce_on_key = "IP"

      rate_limit_threshold {
        count        = var.auth_rate_limit_per_minute
        interval_sec = 60
      }
    }
  }

  rule {
    action      = "allow"
    priority    = 2147483647
    description = "Default allow"

    match {
      versioned_expr = "SRC_IPS_V1"

      config {
        src_ip_ranges = ["*"]
      }
    }
  }
}
