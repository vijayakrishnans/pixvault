terraform {
  required_version = ">= 1.15.0"

  # State lives on the platform (SB1): the runner exports TF_HTTP_* per job, so
  # this block stays empty — no S3 bucket, no AWS role, no workspaces.
  backend "http" {}

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.30"
    }
    external = {
      source  = "hashicorp/external"
      version = "~> 2.3"
    }
  }
}

# --- Providers ---

# Authenticates via the CLOUDFLARE_API_TOKEN env var (provider-native): the
# token is an orun-managed secret resolved into the job env at run time, so it
# never transits Terraform variables.
provider "cloudflare" {}

# --- Variables (standard Orun parameters) ---

variable "cloudflare_account_id" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Cloudflare account ID (from CLOUDFLARE_ACCOUNT_ID env var)"
}

variable "orgName" {
  type    = string
  default = "sourceplane"
}

variable "owner" {
  type    = string
  default = "sourceplane"
}

variable "repo" {
  type    = string
  default = "pixvault"
}

variable "namespace" {
  type    = string
  default = "sourceplane"
}

variable "namespacePrefix" {
  type    = string
  default = ""
}

variable "lane" {
  type    = string
  default = "verify"
}

variable "environment" {
  type    = string
  default = "stage"
}

variable "component" {
  type    = string
  default = "cloudflare-kv-media"
}

variable "stackName" {
  type    = string
  default = "cloudflare-kv-media"
}

variable "terraformDir" {
  type    = string
  default = "terraform"
}

variable "terraformVersion" {
  type    = string
  default = "1.15.3"
}

locals {
  # Pixvault serving (PV3): library maps and file routes, written by media-worker and read by serve-worker.
  # Its own root (not cloudflare-kv) because the brokered workers-deploy token can create KV namespaces but not
  # read them, so any change to an existing KV root fails on refresh (GAPS G44). A fresh root only creates.
  media_routes_namespace_title = "${var.namespacePrefix}${var.repo}-media-routes-${var.environment}"
}

resource "cloudflare_workers_kv_namespace" "media_routes" {
  account_id = var.cloudflare_account_id
  title      = local.media_routes_namespace_title
}

# --- Wiring manifest (via orun secrets): WIRING_CLOUDFLARE_KV_MEDIA on the project/{{env}} rung ---

output "wiring" {
  description = "Wiring document for downstream deploy-time binding resolution (pushed to orun secrets)"
  value = jsonencode({
    media_routes_kv_id    = cloudflare_workers_kv_namespace.media_routes.id
    media_routes_kv_title = cloudflare_workers_kv_namespace.media_routes.title
  })
}

output "media_routes_kv_id" {
  description = "Cloudflare Workers KV namespace ID for Pixvault serving routes"
  value       = cloudflare_workers_kv_namespace.media_routes.id
}
