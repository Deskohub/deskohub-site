# External Application Load Balancer in front of the Cloud Run web service.
# The service's ingress allows only this load balancer and its default
# run.app URL is disabled, so Cloud Armor cannot be bypassed.
#
# By default the edge serves HTTPS with a Google-managed certificate and
# port 80 only redirects to HTTPS. A sandbox proof without DNS may set
# enable_https = false: port 80 then serves the same URL map, backends and
# Cloud Armor policy over plain HTTP, and no certificate is requested.

resource "google_compute_global_address" "workspace" {
  name = "workspace-${var.stage}-edge"
}

resource "google_compute_managed_ssl_certificate" "workspace" {
  count = var.enable_https ? 1 : 0
  name  = "workspace-${var.stage}-edge"

  managed {
    domains = var.domains
  }
}

resource "google_compute_region_network_endpoint_group" "web" {
  name                  = "workspace-${var.stage}-web"
  region                = var.region
  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = var.web_service_name
  }
}

# Dynamic pages, Server Actions, auth and API routes. Never cached. Its
# request logging stays off until token routes move to their own no-log,
# Armor-protected backend, so token URLs never reach the load balancer log.
resource "google_compute_backend_service" "dynamic" {
  name                  = "workspace-${var.stage}-dynamic"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  enable_cdn            = false
  security_policy       = google_compute_security_policy.workspace.id

  backend {
    group = google_compute_region_network_endpoint_group.web.id
  }

  log_config {
    enable = false
  }
}

# Immutable build assets. Cloud CDN is opt-in and honours origin headers.
resource "google_compute_backend_service" "static" {
  name                  = "workspace-${var.stage}-static"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  enable_cdn            = var.static_cdn_enabled
  security_policy       = google_compute_security_policy.workspace.id

  dynamic "cdn_policy" {
    for_each = var.static_cdn_enabled ? [1] : []
    content {
      cache_mode       = "USE_ORIGIN_HEADERS"
      negative_caching = false

      cache_key_policy {
        include_host         = true
        include_protocol     = true
        include_query_string = false
      }
    }
  }

  backend {
    group = google_compute_region_network_endpoint_group.web.id
  }

  log_config {
    enable      = true
    sample_rate = 1
  }
}

resource "google_compute_url_map" "workspace" {
  name            = "workspace-${var.stage}-edge"
  default_service = google_compute_backend_service.dynamic.id

  # Without HTTPS the proof reaches the edge by IP address, so any host
  # matches.
  host_rule {
    hosts        = length(var.domains) > 0 ? var.domains : ["*"]
    path_matcher = "workspace"
  }

  path_matcher {
    name            = "workspace"
    default_service = google_compute_backend_service.dynamic.id

    path_rule {
      paths   = var.static_asset_paths
      service = google_compute_backend_service.static.id
    }
  }
}

resource "google_compute_target_https_proxy" "workspace" {
  count            = var.enable_https ? 1 : 0
  name             = "workspace-${var.stage}-edge"
  url_map          = google_compute_url_map.workspace.id
  ssl_certificates = [google_compute_managed_ssl_certificate.workspace[0].id]
}

resource "google_compute_global_forwarding_rule" "https" {
  count                 = var.enable_https ? 1 : 0
  name                  = "workspace-${var.stage}-https"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.workspace.id
  port_range            = "443"
  target                = google_compute_target_https_proxy.workspace[0].id
}

resource "google_compute_url_map" "https_redirect" {
  count = var.enable_https ? 1 : 0
  name  = "workspace-${var.stage}-https-redirect"

  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
}

resource "google_compute_target_http_proxy" "https_redirect" {
  count   = var.enable_https ? 1 : 0
  name    = "workspace-${var.stage}-https-redirect"
  url_map = google_compute_url_map.https_redirect[0].id
}

# Sandbox-only plain HTTP: port 80 serves the main URL map directly.
resource "google_compute_target_http_proxy" "workspace" {
  count   = var.enable_https ? 0 : 1
  name    = "workspace-${var.stage}-edge-http"
  url_map = google_compute_url_map.workspace.id
}

# Port 80 redirects to HTTPS, or serves the edge when HTTPS is disabled.
resource "google_compute_global_forwarding_rule" "http" {
  name                  = "workspace-${var.stage}-http"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.workspace.id
  port_range            = "80"
  target = (
    var.enable_https
    ? google_compute_target_http_proxy.https_redirect[0].id
    : google_compute_target_http_proxy.workspace[0].id
  )
}

# The HTTPS resources gained count; keep existing state addresses.
moved {
  from = google_compute_managed_ssl_certificate.workspace
  to   = google_compute_managed_ssl_certificate.workspace[0]
}

moved {
  from = google_compute_target_https_proxy.workspace
  to   = google_compute_target_https_proxy.workspace[0]
}

moved {
  from = google_compute_global_forwarding_rule.https
  to   = google_compute_global_forwarding_rule.https[0]
}

moved {
  from = google_compute_url_map.https_redirect
  to   = google_compute_url_map.https_redirect[0]
}

moved {
  from = google_compute_target_http_proxy.https_redirect
  to   = google_compute_target_http_proxy.https_redirect[0]
}
