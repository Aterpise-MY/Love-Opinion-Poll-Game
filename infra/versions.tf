terraform {
  # use_lockfile needs 1.10. Below that the backend below still initialises,
  # but silently ignores it and locks through DynamoDB alone.
  required_version = ">= 1.10.0"

  # Remote state, created out-of-band by scripts/state-backend.sh — run that
  # once before the first `terraform init`. A config cannot hold its own state
  # in a bucket it also manages, so those two resources are not in infra/*.tf.
  #
  # Backend blocks are evaluated before variables exist, so none of this can
  # reference var.project or var.aws_region. The bucket name carries the
  # account ID because S3 bucket names are global.
  backend "s3" {
    bucket = "poll-game-tfstate-022499047467"
    key    = "love-opinion-poll/terraform.tfstate"
    region = "ap-southeast-1"

    encrypt = true

    # Two locks on purpose, during the transition. DynamoDB-based locking is
    # deprecated and will be removed in a future minor version; use_lockfile
    # is the S3-native replacement, which writes a .tflock object beside the
    # state. Keeping both means the day dynamodb_table is removed is a
    # two-line deletion here plus a table teardown, not a migration.
    dynamodb_table = "poll-game-tflock"
    use_lockfile   = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    # The cluster's own API. Everything in k8s.tf goes through the first, and
    # the two Helm releases — the load balancer controller and the target
    # group binding — through the second.
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 3.0"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = var.project
      ManagedBy = "terraform"
    }
  }
}

# Both of these talk to a cluster that this same configuration creates, which
# shapes two choices.
#
# The token comes from `aws eks get-token`, run by the provider each time it
# needs one, rather than from an aws_eks_cluster_auth data source. A token is
# good for fifteen minutes, and a first apply spends longer than that waiting
# on the control plane and the Fargate profiles — a token read once up front
# has expired by the time the first Kubernetes object is created. The price is
# that the machine running Terraform needs the AWS CLI on its PATH.
#
# And whoever runs the first apply is the cluster's admin: access_config in
# eks.tf grants it to the creating principal. A different IAM principal running
# a later apply needs an access entry of its own, or every resource in k8s.tf
# fails with Unauthorized.
locals {
  cluster_auth = {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args = [
      "eks", "get-token",
      "--cluster-name", aws_eks_cluster.main.name,
      "--region", var.aws_region,
    ]
  }
}

provider "kubernetes" {
  host                   = aws_eks_cluster.main.endpoint
  cluster_ca_certificate = base64decode(aws_eks_cluster.main.certificate_authority[0].data)

  exec {
    api_version = local.cluster_auth.api_version
    command     = local.cluster_auth.command
    args        = local.cluster_auth.args
  }
}

provider "helm" {
  kubernetes = {
    host                   = aws_eks_cluster.main.endpoint
    cluster_ca_certificate = base64decode(aws_eks_cluster.main.certificate_authority[0].data)

    exec = local.cluster_auth
  }
}
