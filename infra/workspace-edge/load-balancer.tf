# External HTTPS Application Load Balancer in front of the Cloud Run web
# service. The service's ingress allows only this load balancer and its
# default run.app URL is disabled, so Cloud Armor cannot be bypassed.

resource "google_compute_global_address" "workspace" {
  name = "workspace-${var.stage}-edge"
}

resource "google_compute_managed_ssl_certificate" "workspace" {
  name = "workspace-${var.stage}-edge"

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

# Dynamic pages, Server Actions, auth and API routes. Never cached.
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
    enable      = true
    sample_rate = 1
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

  host_rule {
    hosts        = var.domains
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
  name             = "workspace-${var.stage}-edge"
  url_map          = google_compute_url_map.workspace.id
  ssl_certificates = [google_compute_managed_ssl_certificate.workspace.id]
}

resource "google_compute_global_forwarding_rule" "https" {
  name                  = "workspace-${var.stage}-https"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.workspace.id
  port_range            = "443"
  target                = google_compute_target_https_proxy.workspace.id
}

resource "google_compute_url_map" "https_redirect" {
  name = "workspace-${var.stage}-https-redirect"

  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
}

resource "google_compute_target_http_proxy" "https_redirect" {
  name    = "workspace-${var.stage}-https-redirect"
  url_map = google_compute_url_map.https_redirect.id
}

resource "google_compute_global_forwarding_rule" "http" {
  name                  = "workspace-${var.stage}-http"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.workspace.id
  port_range            = "80"
  target                = google_compute_target_http_proxy.https_redirect.id
}
