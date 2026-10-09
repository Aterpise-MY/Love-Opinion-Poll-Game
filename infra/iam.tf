# Two roles that both trust ecs-tasks.amazonaws.com. The difference is who
# uses them, and getting it backwards is the classic ECS mistake:
#
#   execution role  the Fargate infrastructure, around your container —
#                   pulling the image, creating the log stream
#   task role       your code, via the container credential provider at
#                   169.254.170.2
#
# Put the DynamoDB grant on the execution role and the container starts
# perfectly, then every request fails with AccessDeniedException and nothing
# in the ECS console hints at why.

data "aws_iam_policy_document" "assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# ---------------------------------------------------------------------------
# Execution role — infrastructure
# ---------------------------------------------------------------------------

resource "aws_iam_role" "execution" {
  name               = "${local.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.assume_role.json
  tags               = local.tags
}

# The image pull is in here and nowhere else. This managed policy carries the
# ECR read actions and the two CloudWatch Logs ones, which is everything the
# Fargate infrastructure needs to start a task from a private ECR repository in
# the same account — so there is no registry statement further down, and there
# should not be one.
resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# ADMIN_KEY is a `secrets` entry in the container definition, and it is the
# execution role that resolves those before the container starts — not the
# task role. This is the same execution/task split as the header, in the one
# direction that is easy to get wrong twice: the application never calls SSM
# itself, so granting this to the task role instead produces a task that
# cannot start, with ResourceInitializationError and no mention of SSM.
#
# ssm:GetParameters is the whole grant. kms:Decrypt is required only for a
# customer managed key; the parameter uses the aws/ssm managed key.
data "aws_iam_policy_document" "execution_secrets" {
  statement {
    actions   = ["ssm:GetParameters"]
    resources = [aws_ssm_parameter.admin_key.arn]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

# ---------------------------------------------------------------------------
# Task role — the application
# ---------------------------------------------------------------------------

resource "aws_iam_role" "task" {
  name               = "${local.name}-task"
  assume_role_policy = data.aws_iam_policy_document.assume_role.json
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
  role   = aws_iam_role.task.id
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
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.media_upload.json
}

# ECS Exec — the only way to get a shell inside a running task on show day.
data "aws_iam_policy_document" "exec" {
  statement {
    actions = [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "exec" {
  name   = "ecs-exec"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.exec.json
}
