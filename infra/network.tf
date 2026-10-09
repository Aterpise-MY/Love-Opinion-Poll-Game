# A purpose-built VPC: two public subnets for the load balancer and the NAT
# gateway, two private subnets for the pods.
#
# The private pair is not a preference. A Fargate profile on EKS accepts
# private subnets only, so a pod never has a public IP and reaches ECR, STS,
# DynamoDB, S3 and CloudWatch Logs through the NAT gateway. That gateway is a
# fixed hourly charge for as long as the stack stands, which is why there is
# exactly one of them.

data "aws_availability_zones" "available" {
  state = "available"

  # Local Zones and Wavelength zones do not run Fargate.
  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }

  # Some zones do not offer Fargate for EKS. Set this in tfvars if creating a
  # Fargate profile fails on an unsupported availability zone.
  exclude_zone_ids = var.excluded_zone_ids
}

resource "aws_vpc" "main" {
  cidr_block = "10.42.0.0/16"

  # Both required by Fargate on EKS, not merely useful: a pod resolves the
  # cluster endpoint and every AWS API through them.
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

# Where the pods run, and where EKS places the control plane's network
# interfaces. The same two zones as the public pair, so each zone's load
# balancer node has targets it can reach without crossing zones.
resource "aws_subnet" "private" {
  count = 2

  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.42.${count.index + 10}.0/24"
  availability_zone = data.aws_availability_zones.available.names[count.index]

  tags = { Name = "${local.name}-private-${count.index}" }
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

# One NAT gateway, in the first zone, shared by both private subnets. If that
# zone fails, pods in the other one keep running but lose their way out: no
# image pulls, no fresh credentials from STS, no DynamoDB. For a stack that
# exists for an afternoon that is the right trade. Give each private subnet its
# own gateway and route table if this ever has to outlive one.
resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "${local.name}-nat" }

  depends_on = [aws_internet_gateway.main]
}

resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id

  tags = { Name = local.name }

  depends_on = [aws_internet_gateway.main]
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main.id
  }

  tags = { Name = "${local.name}-private" }
}

resource "aws_route_table_association" "private" {
  count = length(aws_subnet.private)

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
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

# A pod on Fargate is given the cluster security group — the one EKS creates
# alongside the cluster — and there is nothing to attach a group of our own
# to. Out of the box that group admits only its own members, so this rule is
# what lets the load balancer's health checks and traffic reach a pod at all.
#
# Source is the ALB's security group, not a CIDR, and the port is the app's
# alone. Without it the targets register and then sit at "unhealthy: request
# timed out" for ever, which reads like a broken container and is not.
resource "aws_vpc_security_group_ingress_rule" "pods_from_alb" {
  security_group_id            = aws_eks_cluster.main.vpc_config[0].cluster_security_group_id
  referenced_security_group_id = aws_security_group.alb.id

  description = "App port from the load balancer"
  from_port   = var.container_port
  to_port     = var.container_port
  ip_protocol = "tcp"

  tags = { Name = "${local.name}-pods-from-alb" }
}
