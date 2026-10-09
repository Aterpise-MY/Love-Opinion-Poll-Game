output "site_url" {
  description = "What the QR code points at. Same origin for the frontend and the API."
  value       = local.site_url
}

output "screen_url" {
  description = "Projector view. Open this in a separate window on the external display."
  value       = "${local.site_url}/screen"
}

output "operator_url" {
  description = "The six buttons that run the show. Open on a phone, never on the projector."
  value       = "${local.site_url}/operator?k=${local.admin_key}"
  sensitive   = true
}

output "setup_url" {
  description = "Pre-show page: room links, the QR, and the question content."
  value       = "${local.site_url}/admin?k=${local.admin_key}"
  sensitive   = true
}

output "admin_key" {
  description = "Operator console key. Read it with: terraform output -raw admin_key"
  value       = local.admin_key
  sensitive   = true
}

output "acm_validation_records" {
  description = "DNS records proving domain ownership. Empty unless domain_name is set and manage_dns = false."
  value = local.https_enabled ? [
    for option in aws_acm_certificate.app[0].domain_validation_options : {
      name  = option.resource_record_name
      type  = option.resource_record_type
      value = option.resource_record_value
    }
  ] : []
}

output "ecr_repository_url" {
  description = "Push target for scripts/bootstrap.sh and scripts/deploy.sh."
  value       = aws_ecr_repository.app.repository_url
}

output "aws_region" {
  description = "Read back by the deploy scripts so the region is defined in one place."
  value       = var.aws_region
}

output "image_tag" {
  description = "The tag currently deployed. Lets --no-build re-apply without a rebuild."
  value       = var.image_tag
}

output "alb_dns_name" {
  description = "The load balancer's own name. Useful for debugging DNS, not for the audience."
  value       = aws_lb.main.dns_name
}

output "cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "service_name" {
  value = aws_ecs_service.app.name
}

output "target_group_arn" {
  description = "For: aws elbv2 describe-target-health --target-group-arn ..."
  value       = aws_lb_target_group.app.arn
}

output "log_group_name" {
  value = aws_cloudwatch_log_group.app.name
}

output "table_name" {
  value = aws_dynamodb_table.poll.name
}

output "github_actions_setup" {
  description = <<-DESC
    Everything .github/workflows/deploy.yml needs. Set AWS_ROLE_ARN as a repo
    secret and the rest as repo variables:
      gh secret set AWS_ROLE_ARN --body "$(terraform -chdir=infra output -json github_actions_setup | jq -r .AWS_ROLE_ARN)"

    ECR_REPOSITORY is the repository NAME, not its URL. The workflow joins it
    to the registry host that the ECR login step returns.
  DESC
  value = local.github_oidc_enabled ? {
    AWS_ROLE_ARN       = aws_iam_role.github[0].arn
    AWS_REGION         = var.aws_region
    ECR_REPOSITORY     = aws_ecr_repository.app.name
    ECS_CLUSTER        = aws_ecs_cluster.main.name
    ECS_SERVICE        = aws_ecs_service.app.name
    ECS_TASK_FAMILY    = aws_ecs_task_definition.app.family
    ECS_CONTAINER_NAME = local.name
    SITE_URL           = local.site_url
  } : null
}

output "media_bucket" {
  description = "Where uploaded pictures, voice clips and video land."
  value       = aws_s3_bucket.media.bucket
}

output "smoke_command" {
  description = "Run the end-to-end check against the deployed stack."
  value       = "BASE=${local.site_url} ADMIN_KEY=$(terraform -chdir=infra output -raw admin_key) ./scripts/smoke.sh"
}
