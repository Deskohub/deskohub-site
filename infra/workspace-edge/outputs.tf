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
