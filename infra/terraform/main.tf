locals {
  name                 = "${var.project}-${var.environment}"
  ssm_parameter_prefix = "/${var.project}/${var.environment}"
  log_group_name       = "/${var.project}/${var.environment}/app"

  tags = {
    Project     = var.project
    Environment = var.environment
    ManagedBy   = "terraform"
    DataClass   = "synthetic"
  }
}

data "aws_caller_identity" "current" {}

data "aws_availability_zones" "available" {
  state = "available"
}

# ------------------------------------------------------------------------------------------- network
# One VPC, one public subnet, no NAT gateway (NAT costs ~$32/month). The instance has a public
# Elastic IP and a tightly scoped security group; datastores are containers on the instance and are
# never published to the network.

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = local.name }
}

# Lock down the default security group so nothing can accidentally use it.
resource "aws_default_security_group" "default" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.name}-default-locked" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = local.name }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, 1)
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = false

  tags = { Name = "${local.name}-public" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "${local.name}-public" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# ------------------------------------------------------------------------------------ security group

resource "aws_security_group" "app" {
  name        = "${local.name}-app"
  description = "PolicyWatch host: HTTP(S) from allowed CIDRs, optional SSH from operator CIDRs"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${local.name}-app" }
}

locals {
  web_ingress = { for pair in setproduct(var.api_ingress_cidrs, [80, 443]) : "${pair[0]}-${pair[1]}" => { cidr = pair[0], port = pair[1] } }
}

resource "aws_vpc_security_group_ingress_rule" "web" {
  for_each = local.web_ingress

  security_group_id = aws_security_group.app.id
  description       = "HTTP(S) to Caddy reverse proxy"
  cidr_ipv4         = each.value.cidr
  ip_protocol       = "tcp"
  from_port         = each.value.port
  to_port           = each.value.port
}

resource "aws_vpc_security_group_ingress_rule" "ssh" {
  for_each = toset(var.ssh_ingress_cidrs)

  security_group_id = aws_security_group.app.id
  description       = "SSH for Ansible (operator addresses only)"
  cidr_ipv4         = each.value
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

# Egress limited to the configured ports. DNS to the VPC resolver and the Amazon Time Sync Service
# (169.254.169.123) are not subject to security-group filtering.
resource "aws_vpc_security_group_egress_rule" "out" {
  for_each = toset([for p in var.webhook_egress_ports : tostring(p)])

  security_group_id = aws_security_group.app.id
  description       = "Outbound TCP ${each.value}"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = tonumber(each.value)
  to_port           = tonumber(each.value)
}
