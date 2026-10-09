# A purpose-built VPC with two public subnets and no NAT Gateway.
#
# Tasks sit in public subnets with a public IP and egress through the internet
# gateway. That saves the ~$32/month a NAT Gateway would cost for a stack that
# exists for one afternoon, and the tasks are still unreachable from outside
# because their security group only accepts traffic from the load balancer.

data "aws_availability_zones" "available" {
  state = "available"

  # Local Zones and Wavelength zones do not run Fargate.
  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }

  # Some zones do not offer ARM64 Fargate. Set this in tfvars if an apply
  # fails with a capacity or unsupported-configuration error.
  exclude_zone_ids = var.excluded_zone_ids
}

resource "aws_vpc" "main" {
  cidr_block           = "10.42.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = local.name }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = local.name }
}

# Two is the floor: an ALB requires subnets in at least two availability zones.
resource "aws_subnet" "public" {
  count = 2

  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.42.${count.index}.0/24"
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true

  tags = { Name = "${local.name}-public-${count.index}" }
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
  count = length(aws_subnet.public)

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# ---------------------------------------------------------------------------
# Security groups
# ---------------------------------------------------------------------------

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "Public HTTP/HTTPS to the load balancer"
  vpc_id      = aws_vpc.main.id

  ingress {
    description      = "HTTP (redirected to HTTPS)"
    from_port        = 80
    to_port          = 80
    protocol         = "tcp"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  ingress {
    description      = "HTTPS"
    from_port        = 443
    to_port          = 443
    protocol         = "tcp"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  egress {
    from_port        = 0
    to_port          = 0
    protocol         = "-1"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  tags = { Name = "${local.name}-alb" }
}

resource "aws_security_group" "task" {
  name        = "${local.name}-task"
  description = "Application port, load balancer only"
  vpc_id      = aws_vpc.main.id

  # Source is the ALB's security group, not a CIDR. The tasks have public IPs
  # so that they can pull from ECR without a NAT — without this restriction
  # they would be directly reachable from the internet.
  ingress {
    description     = "App port from the load balancer"
    from_port       = var.container_port
    to_port         = var.container_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  # Outbound is needed for ECR, DynamoDB, S3 and CloudWatch Logs.
  egress {
    from_port        = 0
    to_port          = 0
    protocol         = "-1"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  tags = { Name = "${local.name}-task" }
}
