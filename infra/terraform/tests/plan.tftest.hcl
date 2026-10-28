# Offline plan tests: `terraform test` (no AWS credentials, no API calls — the provider is mocked).
# They pin the security-relevant decisions so a refactor cannot silently weaken them.

mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = { names = ["us-east-1a", "us-east-1b"] }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_ssm_parameter" {
    defaults = { value = "ami-0123456789abcdef0" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:us-east-1:123456789012:log-group:/policywatch/demo/app" }
  }
  mock_resource "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:us-east-1:123456789012:policywatch-demo-alarms" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/policywatch-demo" }
  }
}

variables {
  api_ingress_cidrs = ["203.0.113.7/32"]
  ssh_ingress_cidrs = ["198.51.100.20/32"]
  ssh_public_key    = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE operator@example"
}

run "instance_hardening" {
  command = plan

  assert {
    condition     = aws_instance.app.metadata_options[0].http_tokens == "required"
    error_message = "IMDSv2 must be required."
  }
  assert {
    condition     = aws_instance.app.metadata_options[0].http_put_response_hop_limit == 1
    error_message = "IMDS hop limit must be 1 so containers cannot reach instance metadata."
  }
  assert {
    condition     = aws_instance.app.root_block_device[0].encrypted
    error_message = "Root volume must be encrypted."
  }
  assert {
    condition     = aws_instance.app.credit_specification[0].cpu_credits == "standard"
    error_message = "Burstable credits must be 'standard' to avoid surprise charges."
  }
  assert {
    condition     = aws_instance.app.monitoring == false
    error_message = "Detailed monitoring is billed and unnecessary here."
  }
}

run "network_exposure" {
  command = plan

  assert {
    condition     = toset([for r in aws_vpc_security_group_ingress_rule.web : r.from_port]) == toset([80, 443])
    error_message = "Only 80/443 may be open to API clients."
  }
  assert {
    condition     = alltrue([for r in aws_vpc_security_group_ingress_rule.web : r.cidr_ipv4 == "203.0.113.7/32"])
    error_message = "Web ingress must be limited to api_ingress_cidrs."
  }
  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.ssh) == 1 && aws_vpc_security_group_ingress_rule.ssh["198.51.100.20/32"].from_port == 22
    error_message = "SSH must be limited to the operator CIDR."
  }
  assert {
    condition     = toset([for r in aws_vpc_security_group_egress_rule.out : r.from_port]) == toset([80, 443])
    error_message = "Egress defaults to 80/443 only."
  }
  assert {
    condition     = aws_subnet.public.map_public_ip_on_launch == false
    error_message = "Public IPs come from the Elastic IP only."
  }
}

run "ssh_closed_by_default" {
  command = plan

  variables {
    ssh_ingress_cidrs = []
    ssh_public_key    = ""
  }

  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.ssh) == 0 && length(aws_key_pair.operator) == 0
    error_message = "With no operator CIDRs, port 22 must stay closed and no key pair is created."
  }
}

run "rejects_ssh_from_anywhere" {
  command = plan

  variables {
    ssh_ingress_cidrs = ["0.0.0.0/0"]
  }

  expect_failures = [var.ssh_ingress_cidrs]
}

run "requires_explicit_api_ingress" {
  command = plan

  variables {
    api_ingress_cidrs = []
  }

  expect_failures = [var.api_ingress_cidrs]
}

run "optional_cost_items_can_be_disabled" {
  command = plan

  variables {
    enable_alarms          = false
    enable_daily_snapshots = false
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.system_status) == 0 && length(aws_sns_topic.alarms) == 0 && length(aws_dlm_lifecycle_policy.daily) == 0
    error_message = "Alarms, SNS and DLM must be optional."
  }
}

run "log_retention_and_filters" {
  command = plan

  assert {
    condition     = aws_cloudwatch_log_group.app.retention_in_days == 14
    error_message = "Logs must expire (default 14 days)."
  }
  assert {
    condition     = length(aws_cloudwatch_log_metric_filter.app) == 5
    error_message = "Expected the five log-derived metrics."
  }
}
