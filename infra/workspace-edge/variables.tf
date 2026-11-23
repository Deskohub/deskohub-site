variable "project_id" {
  description = "Google Cloud project of this stage. Each stage has its own project."
  type        = string
}

variable "stage" {
  description = "Workspace stage this edge serves."
  type        = string

  validation {
    condition     = contains(["sandbox", "preview", "production"], var.stage)
    error_message = "stage must be sandbox, preview or production."
  }
}

variable "region" {
  description = "Region of the Cloud Run web service."
  type        = string
  default     = "europe-west1"
}

variable "domains" {
  description = "Hostnames the managed certificate covers and the URL map routes. May be empty only when enable_https is false, which then matches any host."
  type        = list(string)

  validation {
    condition     = length(var.domains) > 0 || !var.enable_https
    error_message = "domains must name at least one hostname while enable_https is true."
  }
}

variable "enable_https" {
  description = "Serve HTTPS with a managed certificate and redirect port 80 to it. Only the sandbox may set false, to serve plain HTTP on port 80 for a proof without DNS."
  type        = bool
  default     = true

  validation {
    condition     = var.enable_https || var.stage == "sandbox"
    error_message = "enable_https may be false only when stage is sandbox."
  }
}

variable "web_service_name" {
  description = "Cloud Run service the serverless NEG targets (declared by Alchemy)."
  type        = string
  default     = "workspace-web"
}

variable "static_cdn_enabled" {
  description = "Opt in to Cloud CDN for immutable static asset paths. Dynamic and auth routes never use CDN."
  type        = bool
  default     = false
}

variable "static_asset_paths" {
  description = "Path patterns served by the static backend, which alone may use Cloud CDN. Only immutable build-asset paths are allowed."
  type        = list(string)
  default     = ["/_next/static/*", "/app/_expo/static/*", "/polyfills/*"]

  validation {
    condition = length(var.static_asset_paths) > 0 && alltrue([
      for path in var.static_asset_paths :
      contains(["/_next/static/*", "/app/_expo/static/*", "/polyfills/*"], path)
    ])
    error_message = "static_asset_paths may only list /_next/static/*, /app/_expo/static/* and /polyfills/*."
  }
}

variable "auth_rate_limit_per_minute" {
  description = "Requests per minute per client IP to auth endpoints before Cloud Armor throttles."
  type        = number
  default     = 120
}

variable "waf_preview" {
  description = "Run the preconfigured WAF rules in preview (log only) until their false positives are reviewed."
  type        = bool
  default     = true
}
