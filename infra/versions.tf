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
