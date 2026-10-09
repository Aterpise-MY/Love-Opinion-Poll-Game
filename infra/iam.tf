# The role the application itself runs as.
#
# The roles that surround a pod rather than run inside it — the cluster role
# and the Fargate pod execution role — are in eks.tf, with a note on which is
# which. This is the one your code holds: the AWS SDK in the container finds a
# projected service-account token, trades it at STS for this role, and renews
# it on its own.

# The trust policy is the whole boundary. It names one service account in one
# namespace of one cluster, and both conditions matter: without `sub`, any pod
# in the cluster could annotate its own service account with this role's ARN
# and be handed the table.
data "aws_iam_policy_document" "app_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.eks.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.eks_oidc_issuer}:sub"
      values   = ["system:serviceaccount:${local.namespace}:${local.name}"]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.eks_oidc_issuer}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "app" {
  name               = "${local.name}-app"
  assume_role_policy = data.aws_iam_policy_document.app_assume.json
  tags               = local.tags
}

data "aws_iam_policy_document" "table_access" {
  statement {
    actions = [
      "dynamodb:BatchGetItem",
      "dynamodb:BatchWriteItem",
      "dynamodb:DeleteItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:TransactWriteItems",
      "dynamodb:UpdateItem",
    ]
    resources = [aws_dynamodb_table.poll.arn]
  }
}

resource "aws_iam_role_policy" "table_access" {
  name   = "table-access"
  role   = aws_iam_role.app.id
  policy = data.aws_iam_policy_document.table_access.json
}

# PutObject and DeleteObject, both scoped to questions/ and to nothing else.
#
# Delete is here because 移除 on the setup page has to actually remove the file.
# Without it, taking a picture off a question only dropped the reference: the
# object stayed publicly readable at its url until the lifecycle rule below
# collected it, and a 40MB clip replaced twice during rehearsal left both of the
# old ones behind. The app deletes only what a save has just orphaned, and only
# after checking no other question or option still points at it.
#
# The lifecycle rule stays. It is now the backstop for the orphans a failed
# delete leaves — the app treats a delete failure as a warning and lets the save
# through — rather than the only thing that ever collects them.
data "aws_iam_policy_document" "media_upload" {
  statement {
    actions   = ["s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.media.arn}/questions/*"]
  }
}

resource "aws_iam_role_policy" "media_upload" {
  name   = "media-upload"
  role   = aws_iam_role.app.id
  policy = data.aws_iam_policy_document.media_upload.json
}

# Nothing here for a shell. `kubectl exec` reaches a Fargate pod through the
# cluster's API server, on the caller's own Kubernetes permissions, so getting
# inside a running pod on show day needs no IAM grant on the app's role.
