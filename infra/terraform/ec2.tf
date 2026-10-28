# Latest Amazon Linux 2023 (arm64) published by AWS. lifecycle.ignore_changes keeps a new AMI release
# from replacing the instance on the next apply; patching is Ansible's job (dnf-automatic).
data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

resource "aws_key_pair" "operator" {
  count      = var.ssh_public_key == "" ? 0 : 1
  key_name   = "${local.name}-operator"
  public_key = var.ssh_public_key
}

resource "aws_instance" "app" {
  ami                    = nonsensitive(data.aws_ssm_parameter.al2023_arm64.value)
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.app.id]
  iam_instance_profile   = aws_iam_instance_profile.instance.name
  key_name               = var.ssh_public_key == "" ? null : aws_key_pair.operator[0].key_name
  monitoring             = false # detailed monitoring is billed; 5-minute basic metrics suffice

  # Burst credits in "standard" mode: CPU is throttled at zero credits instead of billing surplus.
  credit_specification {
    cpu_credits = "standard"
  }

  # IMDSv2 only, and a hop limit of 1 so containers (one network hop further) cannot reach the
  # metadata endpoint at all — defense in depth behind the application's SSRF guard.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_size_gb
    encrypted             = true
    delete_on_termination = true
    tags = merge(local.tags, {
      Name     = "${local.name}-root"
      Snapshot = "${local.name}-daily"
    })
  }

  user_data = templatefile("${path.module}/templates/user_data.sh.tftpl", {
    hostname = local.name
  })
  user_data_replace_on_change = false

  tags = { Name = local.name }

  lifecycle {
    ignore_changes = [ami, user_data]
  }
}

resource "aws_eip" "app" {
  domain   = "vpc"
  instance = aws_instance.app.id
  tags     = { Name = local.name }

  depends_on = [aws_internet_gateway.main]
}
