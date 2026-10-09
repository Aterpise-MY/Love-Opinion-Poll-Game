# ACM certificate and DNS.
#
# Nothing in this file is created when domain_name is empty. That is the
# no-DNS bootstrapping mode — the ALB serves HTTP on its own name and the whole
# certificate dance is skipped, so the stack can stand up and CI can deploy
# before a domain exists. See var.domain_name.
#
# With a domain set, two modes share one code path:
#   manage_dns = true   Route53 hosted zone in this account; validation records
#                       and the alias record are created automatically.
#   manage_dns = false  You add the records by hand at your DNS provider. The
#                       apply BLOCKS on aws_acm_certificate_validation until the
#                       certificate is issued, which is the behaviour you want —
#                       read `terraform output acm_validation_records` first.
#
# Do this days before the event. It is the longest-lead item in the stack:
# minutes with Route53, unbounded when a human has to paste records somewhere.

resource "aws_acm_certificate" "app" {
  count = local.https_enabled ? 1 : 0

  domain_name       = var.domain_name
  validation_method = "DNS"

  # The certificate must live in the same region as the ALB (unlike
  # CloudFront, which requires us-east-1).
  lifecycle {
    create_before_destroy = true
  }

  tags = local.tags
}

data "aws_route53_zone" "app" {
  count = local.https_enabled && var.manage_dns ? 1 : 0
  name  = var.hosted_zone_name
}

resource "aws_route53_record" "validation" {
  for_each = local.https_enabled && var.manage_dns ? {
    for option in aws_acm_certificate.app[0].domain_validation_options :
    option.domain_name => option
  } : {}

  zone_id         = data.aws_route53_zone.app[0].zone_id
  name            = each.value.resource_record_name
  type            = each.value.resource_record_type
  records         = [each.value.resource_record_value]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "app" {
  count = local.https_enabled ? 1 : 0

  certificate_arn = aws_acm_certificate.app[0].arn

  validation_record_fqdns = var.manage_dns ? [
    for record in aws_route53_record.validation : record.fqdn
  ] : null

  timeouts {
    create = "45m"
  }
}

# An alias, never a hand-typed CNAME to the load balancer's DNS name: if the
# ALB is ever recreated the alias follows it automatically.
resource "aws_route53_record" "alias" {
  count = local.https_enabled && var.manage_dns ? 1 : 0

  zone_id = data.aws_route53_zone.app[0].zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}
