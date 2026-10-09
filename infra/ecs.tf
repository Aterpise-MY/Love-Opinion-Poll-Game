resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${local.name}"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_ecs_cluster" "main" {
  name = local.name
  tags = local.tags
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name = aws_ecs_cluster.main.name

  # FARGATE only. A two-minute Spot interruption notice arriving mid-reveal is
  # not a risk worth taking to save well under a dollar.
  capacity_providers = ["FARGATE"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

resource "aws_ecs_task_definition" "app" {
  family                   = local.name
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]

  # 1 vCPU rather than the 0.25 minimum. Every /state does a SigV4 signature,
  # a JSON round trip and a pooled call to DynamoDB, and 0.25 vCPU is
  # throttled to a quarter core. Two tasks for a rehearsal day plus the show
  # costs under $2 — being cheap on the one resource that has to survive 300
  # simultaneous strangers is the wrong economy, and the headroom is what lets
  # the /state cache stay switched off.
  cpu    = var.task_cpu
  memory = var.task_memory

  # Must match `docker buildx build --platform linux/arm64`. The default here
  # is X86_64, and the mismatch shows up as a task that exits instantly.
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  execution_role_arn = aws_iam_role.execution.arn
  task_role_arn      = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name      = local.name
    image     = "${aws_ecr_repository.app.repository_url}:${var.image_tag}"
    essential = true

    portMappings = [{
      containerPort = var.container_port
      protocol      = "tcp"
    }]

    # Kill a wedged process in 15s rather than the 30s default.
    stopTimeout = 15

    environment = [
      { name = "TABLE_NAME", value = aws_dynamodb_table.poll.name },
      { name = "GAME_ID", value = var.game_id },
      { name = "MEDIA_BUCKET", value = aws_s3_bucket.media.bucket },
      {
        name  = "MEDIA_BASE_URL"
        value = "https://${aws_s3_bucket.media.bucket}.s3.${var.aws_region}.amazonaws.com"
      },
      # Lambda injected this automatically; Fargate does not, and a task has
      # no IMDS region fallback. Without it the SDK throws "Region is missing"
      # on the first call.
      { name = "AWS_REGION", value = var.aws_region },
      { name = "NODE_ENV", value = "production" },
      { name = "PORT", value = tostring(var.container_port) },
    ]

    # Fetched by the EXECUTION role at task start and injected as a normal
    # environment variable inside the container — the application reads
    # process.env.ADMIN_KEY exactly as before, so nothing in backend/ changes.
    # Only this ARN is stored in the task definition revision.
    secrets = [
      { name = "ADMIN_KEY", valueFrom = aws_ssm_parameter.admin_key.arn },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.app.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "app"
      }
    }
  }])

  tags = local.tags
}

resource "aws_ecs_service" "app" {
  name            = local.name
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = var.desired_count

  launch_type      = "FARGATE"
  platform_version = "1.4.0"

  network_configuration {
    subnets         = aws_subnet.public[*].id
    security_groups = [aws_security_group.task.id]

    # Mandatory, not cosmetic: without a public IP a task in a public subnet
    # cannot reach ECR and dies with CannotPullContainerError. This is what
    # replaces a NAT Gateway.
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = local.name
    container_port   = var.container_port
  }

  health_check_grace_period_seconds = 60

  # A bad image rolls back and makes `terraform apply` fail loudly, rather
  # than returning success while the service quietly runs the old revision.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  wait_for_steady_state              = true

  enable_execute_command = true

  # Both listeners, because only one of them is guaranteed to exist: the HTTPS
  # one is absent in the no-domain mode, and a count = 0 resource here is an
  # empty dependency rather than an error. The service must not start
  # registering targets before something is actually routing to the group.
  depends_on = [
    aws_lb_listener.http,
    aws_lb_listener.https,
    aws_cloudwatch_log_group.app,
    aws_iam_role_policy_attachment.execution,
  ]

  tags = local.tags
}
