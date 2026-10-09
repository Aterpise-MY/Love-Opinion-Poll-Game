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
    expired. Applying it rolls the Deployment back, or fails the pull.

    The image has to be built for linux/amd64. Fargate on EKS has no Arm
    option, and an arm64 image pulls cleanly and then dies at once with
    "exec format error".
  DESC
  type        = string
}

# ---------------------------------------------------------------------------
# Cluster
# ---------------------------------------------------------------------------

variable "kubernetes_version" {
  description = <<-DESC
    EKS control plane version. Fargate pods take the version of the control
    plane at the moment they start, so an upgrade here reaches the app only
    when its pods are next replaced.

    Stay on a version in standard support: once one passes into extended
    support the control plane is billed at several times the rate.
  DESC
  type        = string
  default     = "1.36"
}

# ---------------------------------------------------------------------------
# Sizing
# ---------------------------------------------------------------------------

variable "desired_count" {
  description = "Running pods. Two so a single pod dying mid-show is survivable."
  type        = number
  default     = 2
}

variable "pod_cpu" {
  description = "CPU each pod requests, as a Kubernetes quantity. \"1\" = 1 vCPU."
  type        = string
  default     = "1"
}

variable "pod_memory" {
  description = <<-DESC
    Memory each pod requests, as a Kubernetes quantity.

    Not a round number, and it should not be made one. Fargate adds 256Mi to
    the request for its own components and then rounds up to the next size it
    sells, so 1792Mi is what lands on exactly 1 vCPU / 2 GB. Ask for 2Gi and
    you are billed for 3 GB to use 2. Check what you actually got with:
      kubectl describe pod -n <namespace> <pod> | grep CapacityProvisioned
  DESC
  type        = string
  default     = "1792Mi"
}

variable "container_port" {
  description = "Port the app listens on inside the container."
  type        = number
  default     = 8080
}

# ---------------------------------------------------------------------------
# Microservices — see services.tf
# ---------------------------------------------------------------------------

variable "realtime_enabled" {
  description = <<-DESC
    false turns off every real-time microservice at once — player,
    voting-core, state-sync, risk — and the Redis they share, whatever
    service_image_tags says. The app keeps running, and with it the operator
    screen, the setup page and the projector views.

    This is the infrastructure half of 离线模式, for a show the host runs
    entirely from the operator screen: nothing real-time is left to pay for or
    to go wrong. It does not flip the game's own offline switch. That one is
    on the setup page, lives in the game state, and is what stops phones
    voting through the app and takes the QR code and the results off the
    projector — turn it on there as well.

    Leave this true to keep the services running and let that setup-page
    switch silence them instead: each one reads the flag from the app and
    stops its real-time work while it is on.
  DESC
  type        = bool
  default     = true
}

variable "service_image_tags" {
  description = <<-DESC
    ECR tag to run for each microservice, keyed by service name:

      service_image_tags = {
        "player"      = "20261008-101500-abc1234"
        "voting-core" = "20261008-101500-abc1234"
        "state-sync"  = "20261008-101500-abc1234"
        "risk"        = "20261008-101500-abc1234"
      }

    A service with no entry is not deployed at all, and with the map empty
    there is no Redis either. Their ECR repositories exist regardless, so an
    image can be pushed before its service is switched on. Like image_tag,
    the tag must be a linux/amd64 image that is actually in the repository.

    player and voting-core each ask risk before they accept anything, so
    neither can be switched on without it.
  DESC
  type        = map(string)
  default     = {}

  validation {
    condition = alltrue([
      for name in keys(var.service_image_tags) : contains(["player", "voting-core", "state-sync", "risk"], name)
    ])
    error_message = "service_image_tags keys must be player, voting-core, state-sync or risk."
  }

  validation {
    condition = (
      !(contains(keys(var.service_image_tags), "player") || contains(keys(var.service_image_tags), "voting-core"))
      || contains(keys(var.service_image_tags), "risk")
    )
    error_message = "player and voting-core call risk on every request: give risk a tag as well."
  }
}

variable "redis_node_type" {
  description = <<-DESC
    ElastiCache node size. Two of these run, in two zones, whenever at least
    one microservice is enabled. The smallest is ample for a room of a few
    hundred phones: the whole dataset is a few sets and counters per question.
  DESC
  type        = string
  default     = "cache.t4g.micro"
}

variable "excluded_zone_ids" {
  description = "Availability zone IDs to avoid, e.g. [\"use1-az3\"] where Fargate for EKS is unavailable."
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
