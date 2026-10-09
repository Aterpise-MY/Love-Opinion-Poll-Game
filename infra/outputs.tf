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
  value = aws_eks_cluster.main.name
}

output "namespace" {
  description = "Where the app's Deployment, Service and Secret live."
  value       = kubernetes_namespace_v1.app.metadata[0].name
}

output "deployment_name" {
  value = kubernetes_deployment_v1.app.metadata[0].name
}

output "service_ecr_repository_urls" {
  description = "Push targets for the microservices in services.tf, keyed by service name."
  value       = { for name, repository in aws_ecr_repository.service : name => repository.repository_url }
}

output "redis_endpoint" {
  description = "Primary endpoint the microservices connect to, over TLS. Null until one of them is enabled."
  value       = local.redis_enabled ? "${aws_elasticache_replication_group.main[0].primary_endpoint_address}:6379" : null
}

output "kubeconfig_command" {
  description = "Point kubectl at the cluster. Works for the principal that ran the first apply."
  value       = "aws eks update-kubeconfig --region ${var.aws_region} --name ${aws_eks_cluster.main.name}"
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
    AWS_ROLE_ARN   = aws_iam_role.github[0].arn
    AWS_REGION     = var.aws_region
    ECR_REPOSITORY = aws_ecr_repository.app.name
    EKS_CLUSTER    = aws_eks_cluster.main.name
    K8S_NAMESPACE  = kubernetes_namespace_v1.app.metadata[0].name
    K8S_DEPLOYMENT = kubernetes_deployment_v1.app.metadata[0].name
    K8S_CONTAINER  = local.name
    SITE_URL       = local.site_url
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
