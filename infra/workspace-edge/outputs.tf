output "edge_ip_address" {
  description = "Global IP address to point the stage's DNS at."
  value       = google_compute_global_address.workspace.address
}

output "security_policy" {
  description = "Cloud Armor policy attached to both backends."
  value       = google_compute_security_policy.workspace.name
}

output "backend_services" {
  description = "Dynamic and static backend services."
  value = {
    dynamic = google_compute_backend_service.dynamic.name
    static  = google_compute_backend_service.static.name
  }
}

output "edge_protocol" {
  description = "Protocol clients use to reach the edge: https, or http when the sandbox disables HTTPS."
  value       = var.enable_https ? "https" : "http"
}

output "token_route_exclusion_filter" {
  description = "Filter of the project exclusion that drops token-route request logs; the hosted proof requires every sink to apply it."
  value       = google_logging_project_exclusion.token_route_requests.filter
}
