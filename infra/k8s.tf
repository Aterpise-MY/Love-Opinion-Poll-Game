# What runs inside the cluster: the app, the Service in front of it, and the
# binding that puts its pods in the load balancer's target group.

locals {
  namespace = local.name

  app_labels = {
    "app.kubernetes.io/name" = local.name
  }

  # Named after the target group it binds, and that is deliberate. A binding's
  # targetGroupARN is immutable; alb.tf replaces the target group whenever its
  # port or VPC changes, and an in-place update would then be rejected by the
  # controller's webhook. A name that follows the ARN turns the same change
  # into one binding created and one deleted.
  target_group_binding = "${local.name}-${substr(sha256(aws_lb_target_group.app.arn), 0, 8)}"

  app_env = {
    TABLE_NAME     = aws_dynamodb_table.poll.name
    GAME_ID        = var.game_id
    MEDIA_BUCKET   = aws_s3_bucket.media.bucket
    MEDIA_BASE_URL = "https://${aws_s3_bucket.media.bucket}.s3.${var.aws_region}.amazonaws.com"
    # A pod with an IAM role is handed AWS_REGION as a side effect of getting
    # its credentials. It is set here anyway: a Fargate pod has no instance
    # metadata to fall back on, and "Region is missing" on the first DynamoDB
    # call should not depend on a webhook having run.
    AWS_REGION = var.aws_region
    NODE_ENV   = "production"
    PORT       = tostring(var.container_port)
  }
}

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

# Fargate runs a Fluent Bit log router beside every pod and configures it from
# exactly one place: a ConfigMap called aws-logging in a namespace called
# aws-observability, carrying this label. Any other name is ignored without an
# error. No pods run here, so it needs no Fargate profile of its own.
resource "kubernetes_namespace_v1" "aws_observability" {
  metadata {
    name = "aws-observability"

    labels = {
      "aws-observability" = "enabled"
    }
  }

  depends_on = [aws_eks_fargate_profile.system]
}

# Read once, when a pod starts. A change here reaches only pods created after
# it, so anything that should log depends on this.
#
# Only [FILTER], [OUTPUT] and [PARSER] sections are accepted — Fargate owns
# the input — and every pod in the cluster shares the result, so CoreDNS and
# the load balancer controller land in the same group as the app, told apart
# by stream name. The group is Terraform's (eks.tf), hence auto_create_group
# false: the router has no permission to create one, and should not need it.
resource "kubernetes_config_map_v1" "aws_logging" {
  metadata {
    name      = "aws-logging"
    namespace = kubernetes_namespace_v1.aws_observability.metadata[0].name
  }

  data = {
    "flb_log_cw" = "false"

    "filters.conf" = <<-EOT
      [FILTER]
          Name parser
          Match *
          Key_name log
          Parser crio
      [FILTER]
          Name kubernetes
          Match kube.*
          Merge_Log On
          Keep_Log Off
          Buffer_Size 0
          Kube_Meta_Cache_TTL 300s
    EOT

    "output.conf" = <<-EOT
      [OUTPUT]
          Name cloudwatch_logs
          Match kube.*
          region ${var.aws_region}
          log_group_name ${aws_cloudwatch_log_group.app.name}
          log_stream_prefix pod-
          auto_create_group false
    EOT

    "parsers.conf" = <<-EOT
      [PARSER]
          Name crio
          Format Regex
          Regex ^(?<time>[^ ]+) (?<stream>stdout|stderr) (?<logtag>P|F) (?<log>.*)$
          Time_Key    time
          Time_Format %Y-%m-%dT%H:%M:%S.%L%z
    EOT
  }
}

# ---------------------------------------------------------------------------
# The app
# ---------------------------------------------------------------------------

resource "kubernetes_namespace_v1" "app" {
  metadata {
    name = local.namespace

    # Asks the load balancer controller to add a readiness gate to every pod
    # here that sits behind a bound Service. A pod then counts as Ready only
    # once the load balancer reports its target healthy — without it a rollout
    # retires the old pods the moment the new ones pass their own probe, a
    # good ten seconds before the load balancer will send them anything, and
    # the room gets 503s for the difference.
    labels = {
      "elbv2.k8s.aws/pod-readiness-gate-inject" = "enabled"
    }
  }

  # No pod may be created here before the profile that puts it on Fargate.
  depends_on = [aws_eks_fargate_profile.app]
}

# The link between the pod and its IAM role. The annotation names the role;
# the role's trust policy (iam.tf) names this service account back. Both halves
# have to agree, and a mismatch shows up as the app running with no AWS
# credentials at all rather than with the wrong ones.
resource "kubernetes_service_account_v1" "app" {
  metadata {
    name      = local.name
    namespace = kubernetes_namespace_v1.app.metadata[0].name

    annotations = {
      "eks.amazonaws.com/role-arn" = aws_iam_role.app.arn
    }
  }
}

# The operator console key. A Secret rather than a plain env entry on the
# Deployment, and the distinction is the whole point: the CI role may read and
# patch the Deployment, and it has no rule that lets it read a Secret (see
# github-oidc.tf). The application reads process.env.ADMIN_KEY exactly as
# before, so nothing in backend/ changes.
resource "kubernetes_secret_v1" "admin_key" {
  metadata {
    name      = "${local.name}-admin-key"
    namespace = kubernetes_namespace_v1.app.metadata[0].name
  }

  data = {
    ADMIN_KEY = local.admin_key
  }
}

resource "kubernetes_service_v1" "app" {
  metadata {
    name      = local.name
    namespace = kubernetes_namespace_v1.app.metadata[0].name
    labels    = local.app_labels
  }

  spec {
    type     = "ClusterIP"
    selector = local.app_labels

    port {
      name        = "http"
      port        = 80
      target_port = var.container_port
    }
  }
}

# A TargetGroupBinding is a custom resource, and that is why it is a one-file
# Helm chart rather than a kubernetes_manifest. Terraform has to read a custom
# resource's schema from the cluster during plan — and on a first apply there
# is no cluster yet, let alone the controller that installs the definition.
# Helm asks nothing of the cluster until it applies.
resource "helm_release" "target_group_binding" {
  name      = "${local.name}-target-group-binding"
  chart     = "${path.module}/charts/target-group-binding"
  namespace = kubernetes_namespace_v1.app.metadata[0].name

  values = [yamlencode({
    name           = local.target_group_binding
    serviceName    = kubernetes_service_v1.app.metadata[0].name
    servicePort    = 80
    targetGroupARN = aws_lb_target_group.app.arn
  })]

  # The controller's chart is what installs the TargetGroupBinding definition.
  depends_on = [helm_release.lb_controller]
}

resource "kubernetes_deployment_v1" "app" {
  metadata {
    name      = local.name
    namespace = kubernetes_namespace_v1.app.metadata[0].name
    labels    = local.app_labels
  }

  spec {
    replicas = var.desired_count

    selector {
      match_labels = local.app_labels
    }

    # Start a full replacement set, and retire nothing until it is serving.
    strategy {
      type = "RollingUpdate"

      rolling_update {
        max_surge       = "100%"
        max_unavailable = "0"
      }
    }

    template {
      metadata {
        labels = local.app_labels
      }

      spec {
        service_account_name = kubernetes_service_account_v1.app.metadata[0].name

        # preStop below, then up to ten seconds of the server's own draining.
        termination_grace_period_seconds = 30

        container {
          name  = local.name
          image = "${aws_ecr_repository.app.repository_url}:${var.image_tag}"

          port {
            container_port = var.container_port
          }

          # This is the pod's size. Fargate reads the requests, adds 256Mi for
          # its own components and rounds up to the next size it sells — see
          # var.pod_memory for why that is not a round number. Requests and
          # limits are equal because every Fargate pod runs as Guaranteed.
          resources {
            requests = {
              cpu    = var.pod_cpu
              memory = var.pod_memory
            }
            limits = {
              cpu    = var.pod_cpu
              memory = var.pod_memory
            }
          }

          dynamic "env" {
            for_each = local.app_env

            content {
              name  = env.key
              value = env.value
            }
          }

          env {
            name = "ADMIN_KEY"

            value_from {
              secret_key_ref {
                name = kubernetes_secret_v1.admin_key.metadata[0].name
                key  = "ADMIN_KEY"
              }
            }
          }

          # Both probes use /health, which server.js answers without touching
          # DynamoDB on purpose — see the comment there for why a dependency
          # check would turn a transient blip into a total outage. It returns
          # 503 while draining, which is what takes a stopping pod out of the
          # Service.
          readiness_probe {
            http_get {
              path = "/health"
              port = var.container_port
            }

            period_seconds    = 5
            timeout_seconds   = 3
            failure_threshold = 2
          }

          liveness_probe {
            http_get {
              path = "/health"
              port = var.container_port
            }

            initial_delay_seconds = 10
            period_seconds        = 10
            timeout_seconds       = 5
            failure_threshold     = 3
          }

          # Kubernetes sends SIGTERM and removes the pod from the Service at
          # the same instant, and the load balancer needs a few seconds to hear
          # about the second. Without this pause the server starts closing
          # sockets while requests are still being routed to it. Ten seconds
          # covers the deregistration delay in alb.tf with room to spare.
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

  # A Fargate pod takes a minute or two to appear before its container even
  # starts, and the readiness gate adds the load balancer's health checks on
  # top. A bad image never becomes Ready, and this apply then fails loudly at
  # the timeout rather than returning success with nothing serving.
  timeouts {
    create = "15m"
    update = "15m"
  }

  depends_on = [
    # The binding first, or the pods are created without a readiness gate.
    helm_release.target_group_binding,
    # A target group attached to no listener never reports a target healthy,
    # and a gated pod would then never become Ready. Both listeners, because
    # only one of them is guaranteed to exist: the HTTPS one is absent in the
    # no-domain mode, and a count = 0 resource here is an empty dependency
    # rather than an error.
    aws_lb_listener.http,
    aws_lb_listener.https,
    aws_vpc_security_group_ingress_rule.pods_from_alb,
    kubernetes_config_map_v1.aws_logging,
    aws_iam_role_policy.table_access,
    aws_iam_role_policy.media_upload,
  ]
}

# Fargate patches its pods by evicting them, on AWS's schedule and not yours.
# This is what makes that happen one pod at a time.
resource "kubernetes_pod_disruption_budget_v1" "app" {
  metadata {
    name      = local.name
    namespace = kubernetes_namespace_v1.app.metadata[0].name
  }

  spec {
    max_unavailable = "1"

    selector {
      match_labels = local.app_labels
    }
  }
}
