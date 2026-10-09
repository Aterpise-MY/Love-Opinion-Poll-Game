# The role .github/workflows/deploy.yml assumes.
#
# OIDC, not an access key pair in repo secrets: GitHub presents a short-lived
# signed token, STS trades it for credentials that expire in an hour, and there
# is no long-lived secret anywhere to leak or rotate.
#
# It covers both halves of the deploy job and nothing outside it: push an image
# to this stack's one ECR repository, then point the Deployment at it and watch
# the rollout. The same token does both, so there is no registry password and
# no kubeconfig in repo secrets either.
#
# The second half is split across two systems, and it is worth knowing which
# is which. IAM lets the role find the cluster and ask for a token. What that
# token may then do inside the cluster is Kubernetes RBAC, at the bottom of
# this file — and that is where the role's reach is actually drawn.
#
# Created here but never used here — the workflow does not run Terraform.
# Set github_repository in terraform.tfvars to switch it on.

locals {
  github_oidc_enabled = var.github_repository != ""
  github_oidc_url     = "https://token.actions.githubusercontent.com"
}

# AWS validates this provider against public CAs, so the thumbprint is vestigial
# — it is still a required argument, and this is the documented value.
#
# Accounts often already have this provider from another repo, and a second one
# fails with EntityAlreadyExists. Set create_github_oidc_provider = false and
# it will attach to the existing one instead.
resource "aws_iam_openid_connect_provider" "github" {
  count = local.github_oidc_enabled && var.create_github_oidc_provider ? 1 : 0

  url             = local.github_oidc_url
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]

  tags = local.tags
}

data "aws_iam_openid_connect_provider" "github" {
  count = local.github_oidc_enabled && !var.create_github_oidc_provider ? 1 : 0
  url   = local.github_oidc_url
}

locals {
  github_oidc_arn = local.github_oidc_enabled ? (
    var.create_github_oidc_provider
    ? aws_iam_openid_connect_provider.github[0].arn
    : data.aws_iam_openid_connect_provider.github[0].arn
  ) : ""
}

# The subject claim is the whole security boundary. Pinning only the repo would
# let any branch — including one pushed by a fork PR — assume this role.
#
# Two axes, so four values.
#
# The suffix varies by job: one with `environment:` set gets
# ...:environment:NAME, everything else gets ...:ref:refs/heads/BRANCH. The
# workflow uses the production environment; the ref form is here so it keeps
# working if that is ever removed.
#
# The PREFIX varies by repository, which is the part that is easy to get wrong.
# GitHub embeds immutable numeric owner and repository IDs —
# repo:acme@200817910/poll-game@1321579620 — and a policy that only knows the
# name form matches nothing. Both spellings are listed because neither is
# universally correct, and listing both costs no security: every value is still
# pinned to one repository and one environment or branch.
locals {
  github_subject_prefixes = distinct(compact([
    var.github_subject_prefix,
    "repo:${var.github_repository}",
  ]))

  github_subjects = flatten([
    for prefix in local.github_subject_prefixes : [
      "${prefix}:environment:${var.github_environment}",
      "${prefix}:ref:refs/heads/master",
    ]
  ])
}

data "aws_iam_policy_document" "github_assume" {
  count = local.github_oidc_enabled ? 1 : 0

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = local.github_subjects
    }
  }

  # aws-actions/configure-aws-credentials attaches session tags to the request
  # by default — the run log says "7 role session tags are being used". Tagging
  # a session needs its own permission, and without it STS refuses the call and
  # reports it under the OTHER action's name:
  #
  #   Not authorized to perform sts:AssumeRoleWithWebIdentity
  #
  # which sends you looking at a permission that was granted all along. Same
  # conditions, so this grants no reach the statement above does not.
  statement {
    actions = ["sts:TagSession"]

    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = local.github_subjects
    }
  }
}

resource "aws_iam_role" "github" {
  count = local.github_oidc_enabled ? 1 : 0

  name               = "${local.name}-github-deploy"
  assume_role_policy = data.aws_iam_policy_document.github_assume[0].json
  tags               = local.tags
}

data "aws_iam_policy_document" "github_deploy" {
  count = local.github_oidc_enabled ? 1 : 0

  # Registry-wide by definition — this one does not take a resource. It is
  # what `docker login` runs on, and the token it returns opens nothing by
  # itself: every push still has to pass the statement below.
  statement {
    sid       = "EcrAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  # Push, to this stack's repositories and no others: the app's, and one per
  # microservice in services.tf. There is deliberately no delete here and no
  # ecr:PutImageTagMutability — the role can add an image, but it cannot
  # remove one or repoint a tag that a Deployment already names.
  statement {
    sid = "EcrPush"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = concat(
      [aws_ecr_repository.app.arn],
      [for repository in aws_ecr_repository.service : repository.arn],
    )
  }

  # The one EKS action in the policy, and all that IAM has to say about the
  # cluster. `aws eks update-kubeconfig` calls it to learn the endpoint and
  # the certificate authority. Fetching a token needs no permission at all —
  # a token is a presigned STS request — and everything the role does with one
  # is decided by the access entry and the Role below, not here.
  statement {
    sid       = "EksDescribe"
    actions   = ["eks:DescribeCluster"]
    resources = [aws_eks_cluster.main.arn]
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  count = local.github_oidc_enabled ? 1 : 0

  name   = "deploy"
  role   = aws_iam_role.github[0].id
  policy = data.aws_iam_policy_document.github_deploy[0].json
}

# ---------------------------------------------------------------------------
# What the role may do inside the cluster
# ---------------------------------------------------------------------------

locals {
  deployer_group = "${local.name}-deployers"
}

# Maps the IAM role to a Kubernetes group and to nothing else. No EKS access
# policy is associated with it on purpose: the nearest managed one that can
# change a Deployment is the namespace-scoped edit policy, and edit can also
# read every Secret in the namespace — the operator console key among them.
resource "aws_eks_access_entry" "github" {
  count = local.github_oidc_enabled ? 1 : 0

  cluster_name      = aws_eks_cluster.main.name
  principal_arn     = aws_iam_role.github[0].arn
  type              = "STANDARD"
  kubernetes_groups = [local.deployer_group]

  tags = local.tags
}

# Enough to set a new image and watch it roll out, in one namespace. `patch`
# on deployments is what `kubectl set image` uses and what `kubectl rollout
# undo` uses; the read-only rules are what make a failed rollout diagnosable
# from the workflow log instead of from someone's laptop.
#
# There is no rule for secrets, so the key in k8s.tf stays unreadable to CI.
# There is no `create` or `delete` either: the role can move the Deployment to
# another image, and it cannot replace it with a different one.
resource "kubernetes_role_v1" "deployer" {
  count = local.github_oidc_enabled ? 1 : 0

  metadata {
    name      = local.deployer_group
    namespace = kubernetes_namespace_v1.app.metadata[0].name
  }

  rule {
    api_groups = ["apps"]
    resources  = ["deployments"]
    verbs      = ["get", "list", "watch", "patch"]
  }

  rule {
    api_groups = ["apps"]
    resources  = ["replicasets"]
    verbs      = ["get", "list", "watch"]
  }

  rule {
    api_groups = [""]
    resources  = ["pods", "pods/log", "events"]
    verbs      = ["get", "list", "watch"]
  }
}

resource "kubernetes_role_binding_v1" "deployer" {
  count = local.github_oidc_enabled ? 1 : 0

  metadata {
    name      = local.deployer_group
    namespace = kubernetes_namespace_v1.app.metadata[0].name
  }

  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "Role"
    name      = kubernetes_role_v1.deployer[0].metadata[0].name
  }

  subject {
    api_group = "rbac.authorization.k8s.io"
    kind      = "Group"
    name      = local.deployer_group
  }
}
