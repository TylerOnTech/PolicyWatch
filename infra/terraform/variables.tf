variable "aws_region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "us-east-1"
}

variable "project" {
  description = "Name prefix for all resources."
  type        = string
  default     = "policywatch"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,20}$", var.project))
    error_message = "project must be 3-21 lowercase letters, digits or hyphens."
  }
}

variable "environment" {
  description = "Environment name (also the SSM parameter path segment: /<project>/<environment>/...)."
  type        = string
  default     = "demo"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,15}$", var.environment))
    error_message = "environment must be 2-16 lowercase letters, digits or hyphens."
  }
}

variable "instance_type" {
  description = "EC2 instance type. t4g.small (2 vCPU burstable ARM, 2 GiB) fits the full stack."
  type        = string
  default     = "t4g.small"

  validation {
    condition     = can(regex("^t4g\\.", var.instance_type)) || can(regex("^(m|c|r)[0-9]+g", var.instance_type))
    error_message = "The AMI lookup is for arm64 (Graviton). Use a Graviton instance type (t4g.*, m7g.*, ...)."
  }
}

variable "root_volume_size_gb" {
  description = "Encrypted gp3 root volume size (GiB). Holds Docker images, PostgreSQL and Redis data."
  type        = number
  default     = 20

  validation {
    condition     = var.root_volume_size_gb >= 16 && var.root_volume_size_gb <= 200
    error_message = "root_volume_size_gb must be between 16 and 200."
  }
}

variable "vpc_cidr" {
  description = "CIDR block for the dedicated VPC."
  type        = string
  default     = "10.42.0.0/16"
}

variable "api_ingress_cidrs" {
  description = <<-EOT
    CIDR blocks allowed to reach the API on 80/443. No default on purpose: choose explicitly.
    Use your own address (e.g. ["203.0.113.7/32"]) for a private demo, ["0.0.0.0/0"] for a public one.
  EOT
  type        = list(string)

  validation {
    condition     = length(var.api_ingress_cidrs) > 0 && alltrue([for c in var.api_ingress_cidrs : can(cidrnetmask(c))])
    error_message = "api_ingress_cidrs must contain at least one valid IPv4 CIDR."
  }
}

variable "ssh_ingress_cidrs" {
  description = <<-EOT
    CIDR blocks allowed to SSH (port 22) for Ansible. Empty = port 22 closed (use SSM Session Manager).
    Must be specific addresses: 0.0.0.0/0 is rejected.
  EOT
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for c in var.ssh_ingress_cidrs : can(cidrnetmask(c)) && !contains(["0.0.0.0/0"], c)])
    error_message = "ssh_ingress_cidrs must be valid IPv4 CIDRs and must not include 0.0.0.0/0."
  }
}

variable "ssh_public_key" {
  description = "OpenSSH public key for the ec2-user account (used by Ansible). Empty = no key pair."
  type        = string
  default     = ""
}

variable "webhook_egress_ports" {
  description = "TCP ports the instance may open outbound (package repos, image registries, webhooks)."
  type        = list(number)
  default     = [80, 443]
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for application logs."
  type        = number
  default     = 14

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365], var.log_retention_days)
    error_message = "log_retention_days must be a value CloudWatch Logs supports."
  }
}

variable "enable_alarms" {
  description = "Create CloudWatch alarms (about $0.10 per alarm per month) and an SNS topic."
  type        = bool
  default     = true
}

variable "alarm_email" {
  description = "Optional e-mail for alarm notifications (AWS sends a confirmation link)."
  type        = string
  default     = ""
}

variable "enable_daily_snapshots" {
  description = "Daily EBS snapshots of the root volume via Data Lifecycle Manager (7 kept)."
  type        = bool
  default     = true
}

variable "domain_name" {
  description = "Optional DNS name you will point at the Elastic IP. Only used in outputs (Caddy handles TLS)."
  type        = string
  default     = ""
}
