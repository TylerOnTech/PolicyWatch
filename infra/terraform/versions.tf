terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # State is local by default (single operator, portfolio scale). For a team, copy
  # backend.tf.example to backend.tf and use an encrypted, versioned S3 bucket with lockfile locking.
}

provider "aws" {
  region = var.aws_region

  # Credentials come from the standard AWS chain (AWS_PROFILE, SSO, env vars). Never from this repo.
  default_tags {
    tags = local.tags
  }
}
