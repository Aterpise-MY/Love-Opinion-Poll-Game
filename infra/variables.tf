variable "aws_region" {
  description = "Region to deploy into. Pick the one closest to the venue and use it everywhere."
  type        = string
  default     = "ap-southeast-1"
}

variable "project" {
  description = "Name prefix for every resource."
  type        = string
  default     = "love-opinion-poll"
}

# ---------------------------------------------------------------------------
# Domain — required. An ALB's own DNS name cannot serve trusted HTTPS, and a
# browser security warning in front of 300 people is the one failure this
# whole design exists to avoid.
# ---------------------------------------------------------------------------

variable "domain_name" {
  description = <<-DESC
    Domain the app is served on, e.g. poll.example.com. Short enough to read
    aloud.

    Empty is a supported mode, and the only one that needs no DNS at all: no
    certificate is requested, no Route53 records are written, no HTTPS listener
    is created, and the load balancer serves plain HTTP on port 80 at its own
    name. That is enough to get the stack standing and the CI deploy path
    working before anyone owns a domain.

    It is not enough for the show. A QR code that lands on plain HTTP in front
    of an audience is the browser warning this design exists to avoid, and
    camera and microphone capture are blocked outright on an insecure origin.
    Set this and re-apply to add HTTPS; nothing else is recreated.
  DESC
  type        = string
  default     = ""
}

variable "hosted_zone_name" {
  description = "Route53 hosted zone containing domain_name, e.g. example.com. Only used when manage_dns is true."
  type        = string
  default     = ""
}

variable "manage_dns" {
  description = <<-DESC
    true  — Route53 zone in this account; validation and alias records are created for you.
    false — you add the records manually; the apply blocks until the certificate is issued.
            Read `terraform output acm_validation_records` first.
  DESC
  type        = bool
  default     = true
}

# ---------------------------------------------------------------------------
# Image
# ---------------------------------------------------------------------------

variable "image_tag" {
  description = <<-DESC
    ECR tag to deploy, e.g. 20260803-142200. Deliberately has NO default:
    a bare `terraform apply` should fail rather than silently redeploy a stale
    image. scripts/deploy.sh passes it.

    The tag has to exist in the repository, and an old one may not: tags are
    immutable, and the lifecycle policy in ecr.tf keeps only the newest few
    images. CI pushes one on every deploy without telling Terraform, so the
    tag recorded in state can be both older than what is running and already
    expired. Applying it rolls the service back, or fails the pull.
  DESC
  type        = string
}

# ---------------------------------------------------------------------------
# Sizing
# ---------------------------------------------------------------------------

variable "desired_count" {
  description = "Running tasks. Two so a single task dying mid-show is survivable."
  type        = number
  default     = 2
}

variable "task_cpu" {
  description = "Fargate CPU units. 1024 = 1 vCPU."
  type        = number
  default     = 1024
}

variable "task_memory" {
  description = "Fargate memory in MiB."
  type        = number
  default     = 2048
}

variable "container_port" {
  description = "Port the app listens on inside the container."
  type        = number
  default     = 8080
}

variable "excluded_zone_ids" {
  description = "Availability zone IDs to avoid, e.g. [\"use1-az3\"] where ARM64 Fargate is unavailable."
  type        = list(string)
  default     = []
}

# ---------------------------------------------------------------------------
# Application
# ---------------------------------------------------------------------------

variable "admin_key" {
  description = "Operator console key. Leave empty to have one generated."
  type        = string
  default     = ""
  sensitive   = true
}

variable "game_id" {
  description = "Partition key value. Bump to run a second, isolated game on the same table."
  type        = string
  default     = "game#1"
}

variable "log_retention_days" {
  description = "CloudWatch retention for the task log group."
  type        = number
  default     = 7
}

# ---------------------------------------------------------------------------
# CI — see .github/workflows/deploy.yml
# ---------------------------------------------------------------------------

variable "github_repository" {
  description = <<-DESC
    owner/repo allowed to assume the deploy role, e.g. acme/poll-game. Leave
    empty and no CI role is created at all — deploys stay laptop-side through
    scripts/deploy.sh.
  DESC
  type        = string
  default     = ""

  validation {
    condition     = var.github_repository == "" || can(regex("^[^/]+/[^/]+$", var.github_repository))
    error_message = "github_repository must be owner/repo, with no scheme and no trailing slash."
  }
}

variable "github_environment" {
  description = <<-DESC
    GitHub environment the deploy job runs in. It is part of the OIDC subject
    claim, so it must match `environment:` in the workflow. Protect it with a
    required reviewer to get a deploy freeze before a show.
  DESC
  type        = string
  default     = "production"
}

variable "github_subject_prefix" {
  description = <<-DESC
    The literal prefix of the OIDC subject claim GitHub mints for this
    repository, e.g.

      repo:acme@200817910/poll-game@1321579620

    GitHub embeds immutable numeric owner and repository IDs in the subject
    claim, so it is not "repo:<owner>/<repo>" any more. A trust policy written
    against the name form alone never matches, `terraform apply` still
    succeeds, and the only symptom arrives inside a workflow run as

      Not authorized to perform sts:AssumeRoleWithWebIdentity

    Read the real value straight from the API that mints it:

      gh api repos/OWNER/REPO/actions/oidc/customization/sub --jq .sub_claim_prefix

    The IDs are the point: an owner or repository can be renamed, and the name
    form silently follows the new name to a role it should no longer reach.

    Leave empty to trust the name form alone. scripts/check-github-oidc.sh
    will tell you if that is wrong for this repository.
  DESC
  type        = string
  default     = ""
}

variable "create_github_oidc_provider" {
  description = <<-DESC
    false if this AWS account already trusts token.actions.githubusercontent.com
    for another repository — a second provider fails with EntityAlreadyExists.
  DESC
  type        = bool
  default     = true
}

variable "media_retention_days" {
  description = <<-DESC
    How long uploaded pictures, voice clips and video survive in S3. Matches
    the spirit of the table's 7-day ttl: the stack empties itself after the
    event. Raise it if you author content weeks ahead of the show.
  DESC
  type        = number
  default     = 30

  validation {
    condition     = var.media_retention_days >= 1
    error_message = "media_retention_days must be at least 1 — S3 expiration cannot be same-day."
  }
}
