# The cluster, and the Fargate plumbing that lets it run pods with no nodes of
# its own.
#
# Four IAM roles meet in this stack, and each answers to a different caller.
# Getting two of them confused is the classic way to lose an afternoon:
#
#   cluster role         the EKS control plane, managing the cluster's own
#                        network interfaces                        (this file)
#   pod execution role   the Fargate infrastructure around every pod — pulling
#                        the image, shipping the logs               (this file)
#   app role             your code, through its service account       (iam.tf)
#   controller role      the load balancer controller       (lb-controller.tf)
#
# Put the DynamoDB grant on the pod execution role and the container starts
# perfectly, then every request fails with AccessDeniedException: nothing
# running inside a pod can use that role.

data "aws_caller_identity" "current" {}

# ---------------------------------------------------------------------------
# Control plane
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "cluster_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cluster" {
  name               = "${local.name}-cluster"
  assume_role_policy = data.aws_iam_policy_document.cluster_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "cluster" {
  role       = aws_iam_role.cluster.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}

resource "aws_eks_cluster" "main" {
  name     = local.name
  version  = var.kubernetes_version
  role_arn = aws_iam_role.cluster.arn

  vpc_config {
    subnet_ids = aws_subnet.private[*].id

    # Public, because the two things that drive this cluster are both outside
    # the VPC: `terraform apply` on a laptop and kubectl on a GitHub runner.
    # The endpoint still refuses anything without a valid IAM identity that an
    # access entry maps to something. Private as well, so the pods reach the
    # API server without leaving the VPC.
    endpoint_public_access  = true
    endpoint_private_access = true
  }

  # Access entries only — no aws-auth ConfigMap to drift out of step with IAM.
  # The principal that creates the cluster becomes its admin, which is what
  # lets the kubernetes and helm providers in this same apply do their work.
  access_config {
    authentication_mode                         = "API"
    bootstrap_cluster_creator_admin_permissions = true
  }

  tags = local.tags

  depends_on = [aws_iam_role_policy_attachment.cluster]
}

# What lets a Kubernetes service account become an IAM role. It is the only
# way for a pod on Fargate to hold AWS credentials: there is no instance
# metadata service behind a Fargate pod, and EKS Pod Identity needs a
# DaemonSet, which Fargate cannot run.
resource "aws_iam_openid_connect_provider" "eks" {
  url            = aws_eks_cluster.main.identity[0].oidc[0].issuer
  client_id_list = ["sts.amazonaws.com"]

  tags = local.tags
}

locals {
  # The issuer without its scheme, which is how the claims are named in a
  # trust policy: <host>/id/<ID>:sub and <host>/id/<ID>:aud.
  eks_oidc_issuer = replace(aws_iam_openid_connect_provider.eks.url, "https://", "")
}

# ---------------------------------------------------------------------------
# Fargate
# ---------------------------------------------------------------------------

# The condition is confused-deputy protection, and worth the three lines: the
# Fargate service may assume this role only on behalf of a profile that belongs
# to this cluster.
data "aws_iam_policy_document" "pod_execution_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["eks-fargate-pods.amazonaws.com"]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values = [
        "arn:aws:eks:${var.aws_region}:${data.aws_caller_identity.current.account_id}:fargateprofile/${local.name}/*",
      ]
    }
  }
}

resource "aws_iam_role" "pod_execution" {
  name               = "${local.name}-pod-execution"
  assume_role_policy = data.aws_iam_policy_document.pod_execution_assume.json
  tags               = local.tags
}

# The image pull is in here and nowhere else: this managed policy carries the
# ECR read actions, which is everything Fargate needs to start a pod from a
# private repository in the same account.
resource "aws_iam_role_policy_attachment" "pod_execution" {
  role       = aws_iam_role.pod_execution.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSFargatePodExecutionRolePolicy"
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/eks/${local.name}"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

# The managed policy above does not cover logs. The log router that Fargate
# runs beside every pod writes with this role, and with no grant it drops
# every line without a word — the pod is healthy, kubectl logs works, and the
# log group stays empty.
#
# Scoped to the one group, which Terraform creates so that it also owns the
# retention; the router is told not to create its own (see k8s.tf).
data "aws_iam_policy_document" "pod_logs" {
  statement {
    actions = [
      "logs:CreateLogStream",
      "logs:DescribeLogStreams",
      "logs:PutLogEvents",
    ]
    resources = [
      aws_cloudwatch_log_group.app.arn,
      "${aws_cloudwatch_log_group.app.arn}:*",
    ]
  }
}

resource "aws_iam_role_policy" "pod_logs" {
  name   = "logs"
  role   = aws_iam_role.pod_execution.id
  policy = data.aws_iam_policy_document.pod_logs.json
}

# A pod runs on Fargate only if its namespace matches a profile at the moment
# it is scheduled. One that matches nothing sits at Pending indefinitely, and
# creating the profile afterwards does not rescue it — it has to be deleted
# and scheduled again. Hence the depends_on wherever a pod is first created.
#
# This one is for CoreDNS and the load balancer controller.
resource "aws_eks_fargate_profile" "system" {
  cluster_name           = aws_eks_cluster.main.name
  fargate_profile_name   = "kube-system"
  pod_execution_role_arn = aws_iam_role.pod_execution.arn
  subnet_ids             = aws_subnet.private[*].id

  selector {
    namespace = "kube-system"
  }

  tags = local.tags

  depends_on = [
    aws_iam_role_policy_attachment.pod_execution,
    aws_iam_role_policy.pod_logs,
  ]
}

# And this one is for the app.
resource "aws_eks_fargate_profile" "app" {
  cluster_name           = aws_eks_cluster.main.name
  fargate_profile_name   = local.namespace
  pod_execution_role_arn = aws_iam_role.pod_execution.arn
  subnet_ids             = aws_subnet.private[*].id

  selector {
    namespace = local.namespace
  }

  tags = local.tags

  # A cluster creates one profile at a time. Left to run in parallel, the
  # second is refused while the first is still CREATING.
  depends_on = [aws_eks_fargate_profile.system]
}

# CoreDNS, as an EKS add-on so that it can be told where it runs. A new
# cluster's CoreDNS is stamped for EC2 nodes, and on a cluster that has none
# its pods stay Pending — which takes cluster DNS with it, and with DNS every
# pod's ability to find DynamoDB. computeType is the supported switch.
#
# OVERWRITE because the add-on is adopting the Deployment the cluster was
# born with, not installing beside it.
resource "aws_eks_addon" "coredns" {
  cluster_name = aws_eks_cluster.main.name
  addon_name   = "coredns"

  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"

  configuration_values = jsonencode({
    computeType = "Fargate"
  })

  tags = local.tags

  # The profile, or the pods have nowhere to run. The route out through the
  # NAT gateway, or they are scheduled and then cannot pull their image.
  depends_on = [
    aws_eks_fargate_profile.system,
    aws_route_table_association.private,
  ]
}
