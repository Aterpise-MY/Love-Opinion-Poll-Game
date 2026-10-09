# The role .github/workflows/deploy.yml assumes.
#
# OIDC, not an access key pair in repo secrets: GitHub presents a short-lived
# signed token, STS trades it for credentials that expire in an hour, and there
# is no long-lived secret anywhere to leak or rotate.
#
# It covers both halves of the deploy job and nothing outside it: push an image
# to this stack's one ECR repository, then register a task definition revision
# and roll the service onto it. The same token does both, so there is no
# registry password in repo secrets either.
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

  # Push, to this repository and no other. There is deliberately no delete
  # here and no ecr:PutImageTagMutability — the role can add an image, but it
  # cannot remove one or repoint a tag that a task definition already names.
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
    resources = [aws_ecr_repository.app.arn]
  }

  # Neither of these supports resource-level permissions; AWS rejects the
  # policy outright if you try to scope them.
  statement {
    sid = "EcsTaskDefinition"
    actions = [
      "ecs:DescribeTaskDefinition",
      "ecs:RegisterTaskDefinition",
    ]
    resources = ["*"]
  }

  statement {
    sid = "EcsRollout"
    actions = [
      "ecs:DescribeServices",
      "ecs:UpdateService",
    ]
    resources = [aws_ecs_service.app.id]
  }

  # RegisterTaskDefinition hands these two roles to ECS, and without PassRole
  # it fails with an AccessDenied that names neither role — the single most
  # confusing way this pipeline can break. The condition stops the permission
  # being usable to hand these roles to anything other than a task.
  statement {
    sid     = "PassTaskRoles"
    actions = ["iam:PassRole"]
    resources = [
      aws_iam_role.execution.arn,
      aws_iam_role.task.arn,
    ]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  count = local.github_oidc_enabled ? 1 : 0

  name   = "deploy"
  role   = aws_iam_role.github[0].id
  policy = data.aws_iam_policy_document.github_deploy[0].json
}
