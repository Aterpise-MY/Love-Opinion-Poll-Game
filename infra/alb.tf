resource "aws_lb" "main" {
  name               = local.name
  load_balancer_type = "application"
  internal           = false
  subnets            = aws_subnet.public[*].id
  security_groups    = [aws_security_group.alb.id]

  # Must stay below server.keepAliveTimeout (65s) in backend/server.js. If the
  # load balancer's idle timeout is the longer of the two it will reuse a
  # socket that Node has just closed, which shows up as sporadic 502s that
  # look like random application failures.
  idle_timeout = 60

  drop_invalid_header_fields = true

  # Single-use stack: `terraform destroy` has to work on the first try.
  enable_deletion_protection = false

  tags = local.tags
}

resource "aws_lb_target_group" "app" {
  # name_prefix, not name. Changing container_port, target_type or vpc_id
  # forces a replacement, and create_before_destroy below means the new group
  # is created while the old one still exists — with a fixed name that is a
  # guaranteed DuplicateTargetGroupName, and the apply dies holding a listener
  # that still points at the group you were trying to replace. AWS caps this
  # prefix at 6 characters and appends its own suffix.
  name_prefix = substr(local.name, 0, 6)
  port        = var.container_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id

  # Responses are sub-second, so there is nothing to drain. The 300s default
  # would make every deployment crawl.
  deregistration_delay = 5

  # Liveness only. server.js answers this without touching DynamoDB on
  # purpose — see the comment there for why a dependency check would turn a
  # transient blip into a total outage.
  health_check {
    path                = "/health"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 10
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  # A listener holds a reference to the target group, so the replacement has
  # to exist before the old one can go.
  lifecycle {
    create_before_destroy = true
  }

  tags = local.tags
}

resource "aws_lb_listener" "https" {
  count = local.https_enabled ? 1 : 0

  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"

  # Deliberately the validation resource, not aws_acm_certificate.app.arn.
  # Referencing the certificate directly lets the listener be created before
  # the certificate reaches ISSUED, and the apply fails with an opaque
  # CertificateNotFound.
  certificate_arn = aws_acm_certificate_validation.app[0].certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

# Port 80 does one of two jobs depending on whether there is a certificate.
#
# With a domain: it only redirects. Someone will type the bare domain, and a QR
# code that lands on plain HTTP in front of 300 people is exactly the browser
# warning this whole design avoids.
#
# Without one: it is the only way in, so it forwards. This is the no-DNS
# bootstrapping mode — see var.domain_name for why it is not where you stop.
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = local.https_enabled ? "redirect" : "forward"
    target_group_arn = local.https_enabled ? null : aws_lb_target_group.app.arn

    dynamic "redirect" {
      for_each = local.https_enabled ? [1] : []

      content {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }
}
