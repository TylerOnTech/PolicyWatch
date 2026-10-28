output "instance_id" {
  description = "EC2 instance ID (use with SSM Session Manager)."
  value       = aws_instance.app.id
}

output "public_ip" {
  description = "Elastic IP of the PolicyWatch host."
  value       = aws_eip.app.public_ip
}

output "api_url" {
  description = "Base URL of the API (HTTPS once domain_name points at the EIP and SITE_ADDRESS is set)."
  value       = var.domain_name != "" ? "https://${var.domain_name}" : "http://${aws_eip.app.public_ip}"
}

output "ssh_command" {
  description = "SSH command (only works if ssh_ingress_cidrs and ssh_public_key are set)."
  value       = length(var.ssh_ingress_cidrs) > 0 && var.ssh_public_key != "" ? "ssh ec2-user@${aws_eip.app.public_ip}" : "SSH disabled; use: aws ssm start-session --target ${aws_instance.app.id}"
}

output "ssm_session_command" {
  description = "Shell access without SSH."
  value       = "aws ssm start-session --region ${var.aws_region} --target ${aws_instance.app.id}"
}

output "ssm_parameter_prefix" {
  description = "Store application secrets under this SSM path (see docs/deployment-aws.md)."
  value       = local.ssm_parameter_prefix
}

output "cloudwatch_log_group" {
  description = "CloudWatch Logs group receiving all container logs."
  value       = aws_cloudwatch_log_group.app.name
}

output "ansible_inventory" {
  description = "Paste into infra/ansible/inventory/hosts.yml."
  value = yamlencode({
    all = {
      hosts = {
        policywatch = {
          ansible_host         = aws_eip.app.public_ip
          ansible_user         = "ec2-user"
          aws_region           = var.aws_region
          ssm_parameter_prefix = local.ssm_parameter_prefix
          cloudwatch_log_group = aws_cloudwatch_log_group.app.name
          site_address         = var.domain_name != "" ? var.domain_name : ":80"
        }
      }
    }
  })
}
