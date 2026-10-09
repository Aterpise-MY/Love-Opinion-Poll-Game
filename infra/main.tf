locals {
  name      = var.project
  admin_key = var.admin_key != "" ? var.admin_key : random_password.admin_key.result

  # One switch for the whole TLS half of the stack: certificate, validation,
  # HTTPS listener, and every Route53 record. Empty domain_name means none of
  # it is created and the ALB answers on port 80 at its own name — see the
  # variable for why that is a bootstrapping mode and not a destination.
  https_enabled = var.domain_name != ""

  site_url = var.domain_name != "" ? "https://${var.domain_name}" : "http://${aws_lb.main.dns_name}"

  tags = {
    Project   = var.project
    ManagedBy = "terraform"
  }
}

resource "random_password" "admin_key" {
  length  = 20
  special = false
}

# The key reaches the container as a Kubernetes Secret — see k8s.tf, which is
# also where the reason it is not a plain env entry is written down.

# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

resource "aws_dynamodb_table" "poll" {
  name         = local.name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"
  range_key    = "SK"

  attribute {
    name = "PK"
    type = "S"
  }

  attribute {
    name = "SK"
    type = "S"
  }

  # Voter and tally records carry a 7-day ttl, so the table empties itself
  # after the event without anyone remembering to clean it up.
  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
}

# ---------------------------------------------------------------------------
# Question media — pictures, voice clips and video
#
# Uploaded from the setup page, read by every phone and the projector. Public
# read on GET only; writes go through the app's IAM role, which is the only
# principal with PutObject. Served over the S3 REST endpoint, which is HTTPS.
#
# One bucket for all three kinds, not three buckets. They share an access
# pattern (write once before the show, read by everyone during it), a lifetime
# and a prefix, so a second bucket would only buy a second base URL to keep in
# sync and a second policy to get wrong.
# ---------------------------------------------------------------------------

resource "random_id" "bucket_suffix" {
  byte_length = 4
}

resource "aws_s3_bucket" "media" {
  bucket        = "${var.project}-media-${random_id.bucket_suffix.hex}"
  force_destroy = true
}

resource "aws_s3_bucket_ownership_controls" "media" {
  bucket = aws_s3_bucket.media.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "media" {
  bucket = aws_s3_bucket.media.id

  # ACLs stay blocked — public read comes from the bucket policy below, which
  # is scoped to GetObject on questions/*.
  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = false
  restrict_public_buckets = false
}

data "aws_iam_policy_document" "media_public_read" {
  statement {
    sid       = "PublicReadQuestionMedia"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.media.arn}/questions/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }

  # The pages that load this media are HTTPS, so a plain-HTTP fetch would be
  # blocked as mixed content anyway. This makes S3 refuse it first, and stops
  # an object URL pasted into a browser from travelling in the clear.
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.media.arn, "${aws_s3_bucket.media.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "media" {
  bucket = aws_s3_bucket.media.id
  policy = data.aws_iam_policy_document.media_public_read.json

  depends_on = [aws_s3_bucket_public_access_block.media]
}

# Replacing a picture or a clip uploads a new key rather than overwriting the
# old one — the random suffix in the key is what stops phones showing a stale
# file out of their HTTP cache. The app now deletes the file a save orphans, so
# most of those are collected within the second. This is the backstop for the
# ones that are not: a delete that fails is logged and the save is allowed
# through regardless, because a picture the operator cannot remove is worse than
# an object nobody is paying attention to.
resource "aws_s3_bucket_lifecycle_configuration" "media" {
  bucket = aws_s3_bucket.media.id

  rule {
    id     = "expire-question-media"
    status = "Enabled"

    filter {
      prefix = "questions/"
    }

    expiration {
      days = var.media_retention_days
    }
  }

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {}

    # A video upload is the one thing here big enough to be sent as a multipart
    # upload, and an abandoned one is billed until its parts are collected.
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}
