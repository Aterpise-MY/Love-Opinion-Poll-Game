# The four real-time microservices that run beside the app, and the Redis they
# share.
#
#   player        takes the name someone types after scanning the QR code and
#                 makes them a player
#   voting-core   takes a vote: one per player (SADD), count it (HINCRBY),
#                 answer, and write it to DynamoDB afterwards
#   state-sync    holds a WebSocket to every phone and pushes game state to it
#   risk          rate limits and device checks, asked by player before a join
#                 and by voting-core before a vote is counted. In-cluster only
#                 — it has no public path
#
# None of them replaces anything yet. The app in k8s.tf keeps serving the
# pages, the operator and setup consoles, /state and /vote exactly as before;
# these get paths of their own on the load balancer, and nothing moves until
# the frontend is pointed at them.
#
# Two switches decide what runs.
#
# A service runs only once it has an image tag in var.service_image_tags.
# With that map empty this file creates four empty ECR repositories and
# nothing else: no Redis, no pods, no listener rules. That is deliberate — the
# images are built elsewhere, and a Deployment naming an image that does not
# exist would hold every `terraform apply` for fifteen minutes and then fail it.
#
# And var.realtime_enabled = false turns all four off at once, whatever tags
# are set, and Redis with them. That is the infrastructure half of 离线模式:
# a show the host runs from the operator screen needs the app and nothing
# here. The other half is the switch on the setup page, which the services
# learn about from the app — see GAME_STATE_URL below.

locals {
  services = {
    "player" = {
      port     = 8080
      replicas = 2
      cpu      = "250m"
      memory   = "256Mi"

      paths     = ["/api/join", "/api/join/*"]
      priority  = 30
      tg_prefix = "join-"

      # Writes each player to the table once it has answered the phone.
      table_write       = true
      termination_grace = 30
    }

    "voting-core" = {
      # The same port as the app, for all three, and not by coincidence: the
      # one security-group rule in network.tf admits the load balancer on
      # var.container_port and on nothing else. A service that listens
      # anywhere else needs a rule of its own or its targets never go healthy.
      port     = 8080
      replicas = 2

      # 0.5 vCPU / 1 GB once Fargate has added its 256Mi and rounded up. See
      # var.pod_memory for why these are not round numbers.
      cpu    = "500m"
      memory = "768Mi"

      # Paths the load balancer sends here. Chosen not to collide with the
      # app's own /vote and /state, so both can run side by side.
      paths     = ["/api/vote", "/api/vote/*"]
      priority  = 10
      tg_prefix = "vote-"

      table_write       = true
      termination_grace = 30
    }

    "state-sync" = {
      port     = 8080
      replicas = 2
      cpu      = "500m"
      memory   = "768Mi"

      paths     = ["/ws", "/ws/*"]
      priority  = 20
      tg_prefix = "sync-"

      # Longer than the others: every phone in the room is holding a socket
      # to one of these pods, and a pod that is going away should get the
      # chance to close them cleanly so the clients reconnect at once.
      table_write       = false
      termination_grace = 60
    }

    "risk" = {
      port     = 8080
      replicas = 2

      # 0.25 vCPU / 0.5 GB, the smallest size Fargate sells.
      cpu    = "250m"
      memory = "256Mi"

      # No paths: reachable from inside the cluster only, as http://risk.
      paths     = []
      priority  = 0
      tg_prefix = ""

      table_write       = false
      termination_grace = 30
    }
  }

  enabled_services = {
    for name, service in local.services : name => service
    if var.realtime_enabled && contains(keys(var.service_image_tags), name)
  }

  # The ones that hold an IAM role, because they write to the table.
  table_services = {
    for name, service in local.enabled_services : name => service
    if service.table_write
  }

  public_services = {
    for name, service in local.enabled_services : name => service
    if length(service.paths) > 0
  }

  redis_enabled = length(local.enabled_services) > 0

  # What every image is built against. This is a contract, and the other half
  # of it lives in code this repository does not hold:
  #
  #   PORT          listen here
  #   GET /health   200 when able to serve, 503 while draining. Both probes
  #                 and the load balancer's health check call it
  #   REDIS_ADDR    host:port of the primary. TLS is required (REDIS_TLS)
  #   GAME_STATE_URL  the app's own /state, reached inside the cluster. It is
  #                 where a service reads the phase and the `offline` flag, and
  #                 it is how the 离线模式 switch on the setup page reaches
  #                 them: the app needs no change and no Redis client, because
  #                 it already answers this. A service that sees
  #                 `offline: true` stops doing its real-time work — no joins,
  #                 no votes, no tallies pushed — until it reads false again
  #
  # Service names resolve inside the namespace, so player and voting-core
  # reach risk at http://risk with no further configuration.
  service_env_common = {
    GAME_ID        = var.game_id
    AWS_REGION     = var.aws_region
    REDIS_ADDR     = local.redis_enabled ? "${aws_elasticache_replication_group.main[0].primary_endpoint_address}:6379" : ""
    REDIS_TLS      = "true"
    GAME_STATE_URL = "http://${kubernetes_service_v1.app.metadata[0].name}/state"
  }

  service_env = {
    "player" = {
      TABLE_NAME = aws_dynamodb_table.poll.name
      RISK_URL   = "http://risk"
    }
    "voting-core" = {
      TABLE_NAME = aws_dynamodb_table.poll.name
      RISK_URL   = "http://risk"
    }
    "state-sync" = {}
    "risk"       = {}
  }
}

# ---------------------------------------------------------------------------
# Images
# ---------------------------------------------------------------------------

# One repository per service, created whether or not the service is switched
# on: the repository has to exist before the first image can be pushed, and
# the image has to exist before the service can be given a tag.
resource "aws_ecr_repository" "service" {
  for_each = local.services

  name                 = "${local.name}/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = local.tags
}

resource "aws_ecr_lifecycle_policy" "service" {
  for_each = local.services

  repository = aws_ecr_repository.service[each.key].name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the 5 most recent images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 5
      }
      action = { type = "expire" }
    }]
  })
}

# ---------------------------------------------------------------------------
# Redis
# ---------------------------------------------------------------------------

# Reachable from pods and from nothing else. A Fargate pod carries the cluster
# security group (see network.tf), so that group is the source.
resource "aws_security_group" "redis" {
  count = local.redis_enabled ? 1 : 0

  name        = "${local.name}-redis"
  description = "Redis, from the cluster's pods only"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Redis from pods"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_eks_cluster.main.vpc_config[0].cluster_security_group_id]
  }

  tags = { Name = "${local.name}-redis" }
}

resource "aws_elasticache_subnet_group" "main" {
  count = local.redis_enabled ? 1 : 0

  name       = local.name
  subnet_ids = aws_subnet.private[*].id

  tags = local.tags
}

# Valkey, the Redis-compatible engine ElastiCache now leads with. Every
# command the services rely on — SADD, HINCRBY, ZADD, ZREMRANGEBYSCORE, ZCARD,
# PUBLISH — is unchanged, and a Redis client connects to it as it is. Set
# engine to "redis" and engine_version to "7.1" to run Redis OSS instead.
#
# Two nodes in two zones with automatic failover, and that is not caution for
# its own sake. For the length of a question this is the only place a vote
# exists: the dedupe sets and the counters are in memory here, and DynamoDB
# hears about them afterwards. One node would make a single host failure
# cost the room every vote not yet written down.
#
# Cluster mode is off — one shard. The services use multi-key operations
# against keys that would not hash to the same slot, and a room of a few
# hundred phones is nowhere near what one shard can carry.
resource "aws_elasticache_replication_group" "main" {
  count = local.redis_enabled ? 1 : 0

  replication_group_id = local.name
  description          = "Players, vote dedupe sets, counters, rate-limit windows and pub/sub for ${local.name}"

  engine         = "valkey"
  engine_version = "8.2"
  node_type      = var.redis_node_type
  port           = 6379

  num_cache_clusters         = 2
  automatic_failover_enabled = true
  multi_az_enabled           = true

  subnet_group_name  = aws_elasticache_subnet_group.main[0].name
  security_group_ids = [aws_security_group.redis[0].id]

  # In transit as well as at rest, which means clients must connect with TLS
  # — a plain connection is closed without a useful error. REDIS_TLS=true is
  # how the services are told.
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true

  # Nothing here is meant to outlive the event; DynamoDB is the record.
  snapshot_retention_limit = 0
  apply_immediately        = true

  tags = local.tags
}

# ---------------------------------------------------------------------------
# AWS access
# ---------------------------------------------------------------------------

# player and voting-core are the two that touch AWS: each writes what it has
# just accepted to the table after it has answered. state-sync and risk speak
# only to Redis, so they get a service account with no role behind it and hold
# no AWS credentials at all.
#
# One role per service rather than one shared, so that each trust policy names
# exactly one service account.
data "aws_iam_policy_document" "service_assume" {
  for_each = local.table_services

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.eks.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.eks_oidc_issuer}:sub"
      values   = ["system:serviceaccount:${local.namespace}:${each.key}"]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.eks_oidc_issuer}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "service" {
  for_each = local.table_services

  name               = "${local.name}-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.service_assume[each.key].json
  tags               = local.tags
}

# Writes only. Neither service reads back from the table — Redis is what they
# answer from — so there is no Query or GetItem to grant.
data "aws_iam_policy_document" "service_table" {
  statement {
    actions = [
      "dynamodb:BatchWriteItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    ]
    resources = [aws_dynamodb_table.poll.arn]
  }
}

resource "aws_iam_role_policy" "service_table" {
  for_each = local.table_services

  name   = "table-write"
  role   = aws_iam_role.service[each.key].id
  policy = data.aws_iam_policy_document.service_table.json
}

# ---------------------------------------------------------------------------
# Load balancer routing
# ---------------------------------------------------------------------------

resource "aws_lb_target_group" "service" {
  for_each = local.public_services

  name_prefix = each.value.tg_prefix
  port        = each.value.port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id

  deregistration_delay = 5

  health_check {
    path                = "/health"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 10
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  lifecycle {
    create_before_destroy = true
  }

  tags = local.tags
}

# On whichever listener carries traffic: HTTPS when there is a certificate,
# port 80 in the no-domain mode. Everything these rules do not match still
# falls through to the app, which is the listener's default action.
#
# WebSockets need nothing special here — the load balancer passes the upgrade
# through on an ordinary HTTP or HTTPS listener. What they do need is in the
# service: the load balancer closes any connection that carries nothing for
# its idle timeout (60s, alb.tf), so state-sync has to ping every client more
# often than that or the room is disconnected once a minute.
resource "aws_lb_listener_rule" "service" {
  for_each = local.public_services

  listener_arn = local.https_enabled ? aws_lb_listener.https[0].arn : aws_lb_listener.http.arn
  priority     = each.value.priority

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.service[each.key].arn
  }

  condition {
    path_pattern {
      values = each.value.paths
    }
  }

  tags = local.tags
}

# ---------------------------------------------------------------------------
# Workloads
# ---------------------------------------------------------------------------

resource "kubernetes_service_account_v1" "service" {
  for_each = local.enabled_services

  metadata {
    name      = each.key
    namespace = kubernetes_namespace_v1.app.metadata[0].name

    annotations = contains(keys(local.table_services), each.key) ? {
      "eks.amazonaws.com/role-arn" = aws_iam_role.service[each.key].arn
    } : {}
  }
}

resource "kubernetes_service_v1" "service" {
  for_each = local.enabled_services

  metadata {
    name      = each.key
    namespace = kubernetes_namespace_v1.app.metadata[0].name

    labels = {
      "app.kubernetes.io/name"    = each.key
      "app.kubernetes.io/part-of" = local.name
    }
  }

  spec {
    type = "ClusterIP"

    selector = {
      "app.kubernetes.io/name" = each.key
    }

    port {
      name        = "http"
      port        = 80
      target_port = each.value.port
    }
  }
}

# The same one-file chart as the app's binding, once per public service, and
# named after its target group for the same reason — see k8s.tf.
resource "helm_release" "service_target_group_binding" {
  for_each = local.public_services

  name      = "${each.key}-target-group-binding"
  chart     = "${path.module}/charts/target-group-binding"
  namespace = kubernetes_namespace_v1.app.metadata[0].name

  values = [yamlencode({
    name           = "${each.key}-${substr(sha256(aws_lb_target_group.service[each.key].arn), 0, 8)}"
    serviceName    = kubernetes_service_v1.service[each.key].metadata[0].name
    servicePort    = 80
    targetGroupARN = aws_lb_target_group.service[each.key].arn
  })]

  depends_on = [helm_release.lb_controller]
}

resource "kubernetes_deployment_v1" "service" {
  for_each = local.enabled_services

  metadata {
    name      = each.key
    namespace = kubernetes_namespace_v1.app.metadata[0].name

    labels = {
      "app.kubernetes.io/name"    = each.key
      "app.kubernetes.io/part-of" = local.name
    }
  }

  spec {
    replicas = each.value.replicas

    selector {
      match_labels = {
        "app.kubernetes.io/name" = each.key
      }
    }

    strategy {
      type = "RollingUpdate"

      rolling_update {
        max_surge       = "100%"
        max_unavailable = "0"
      }
    }

    template {
      metadata {
        labels = {
          "app.kubernetes.io/name"    = each.key
          "app.kubernetes.io/part-of" = local.name
        }
      }

      spec {
        service_account_name             = kubernetes_service_account_v1.service[each.key].metadata[0].name
        termination_grace_period_seconds = each.value.termination_grace

        container {
          name  = each.key
          image = "${aws_ecr_repository.service[each.key].repository_url}:${var.service_image_tags[each.key]}"

          port {
            container_port = each.value.port
          }

          resources {
            requests = {
              cpu    = each.value.cpu
              memory = each.value.memory
            }
            limits = {
              cpu    = each.value.cpu
              memory = each.value.memory
            }
          }

          dynamic "env" {
            for_each = merge(
              local.service_env_common,
              local.service_env[each.key],
              { PORT = tostring(each.value.port) },
            )

            content {
              name  = env.key
              value = env.value
            }
          }

          readiness_probe {
            http_get {
              path = "/health"
              port = each.value.port
            }

            period_seconds    = 5
            timeout_seconds   = 3
            failure_threshold = 2
          }

          liveness_probe {
            http_get {
              path = "/health"
              port = each.value.port
            }

            initial_delay_seconds = 10
            period_seconds        = 10
            timeout_seconds       = 5
            failure_threshold     = 3
          }

          # The same pause as the app's, for the same reason: the load
          # balancer needs a few seconds to stop sending to a pod that is
          # going away. It needs a `sleep` binary in the image. A scratch or
          # distroless image has none; the hook then fails, Kubernetes logs it
          # and stops the pod anyway, and the cost is a handful of 502s per
          # rollout. Base such an image on something with a shell, or have the
          # service keep serving for ten seconds after SIGTERM.
          lifecycle {
            pre_stop {
              exec {
                command = ["sleep", "10"]
              }
            }
          }
        }
      }
    }
  }

  timeouts {
    create = "15m"
    update = "15m"
  }

  depends_on = [
    # Bindings and rules before pods, as in k8s.tf: a pod created before its
    # binding gets no readiness gate, and a target group with no rule pointing
    # at it never reports a target healthy.
    helm_release.service_target_group_binding,
    aws_lb_listener_rule.service,
    aws_vpc_security_group_ingress_rule.pods_from_alb,
    kubernetes_config_map_v1.aws_logging,
    aws_iam_role_policy.service_table,
  ]
}

resource "kubernetes_pod_disruption_budget_v1" "service" {
  for_each = local.enabled_services

  metadata {
    name      = each.key
    namespace = kubernetes_namespace_v1.app.metadata[0].name
  }

  spec {
    max_unavailable = "1"

    selector {
      match_labels = {
        "app.kubernetes.io/name" = each.key
      }
    }
  }
}
