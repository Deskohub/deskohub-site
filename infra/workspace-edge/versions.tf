# The Workspace edge: the subgraph Alchemy beta.87 does not declare
# (#1452). Terraform owns the whole load balancer, Cloud Armor, Cloud CDN
# and request-log exclusion graph so no field has two owners. Alchemy owns
# the Cloud Run service this edge fronts.
terraform {
  required_version = ">= 1.9"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }

  # Partial configuration: pass bucket and prefix with -backend-config, one
  # state prefix per stage, in the stage's own versioned state bucket.
  backend "gcs" {}
}

provider "google" {
  project = var.project_id
  region  = var.region
}
