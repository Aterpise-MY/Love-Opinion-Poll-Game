# The AWS Load Balancer Controller.
#
# A Fargate pod cannot be reached through a node port — there is no node — so
# the only way a load balancer can send it traffic is by pod IP, and this
# controller is what keeps a target group's list of IPs in step with the pods
# behind a Service.
#
# Here it does that one job and no other. The load balancer, its listeners and
# its target group are all Terraform's, in alb.tf. The controller is handed
# the target group by a TargetGroupBinding (k8s.tf) and registers and
# deregisters pod IPs in it. It creates no AWS resources of its own, which is
# what keeps `terraform destroy` from leaving a load balancer behind that
# nothing in state knows about.

locals {
  # Chart and controller share a version number. 3.5.0 is one release behind
  # the newest on purpose: bump it deliberately, and replace
  # policies/aws-load-balancer-controller.json with that release's
  # docs/install/iam_policy.json in the same change.
  lb_controller_version         = "3.5.0"
  lb_controller_service_account = "aws-load-balancer-controller"
}

data "aws_iam_policy_document" "lb_controller_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.eks.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.eks_oidc_issuer}:sub"
      values   = ["system:serviceaccount:kube-system:${local.lb_controller_service_account}"]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.eks_oidc_issuer}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lb_controller" {
  name               = "${local.name}-lb-controller"
  assume_role_policy = data.aws_iam_policy_document.lb_controller_assume.json
  tags               = local.tags
}

# The project's published policy for this version, vendored unmodified. It is
# broader than a controller that only fills a target group strictly needs,
# but its own conditions already confine the create and delete actions to
# resources the controller tagged, and a hand-trimmed copy is one more thing to
# get wrong at every upgrade.
resource "aws_iam_role_policy" "lb_controller" {
  name   = "load-balancer-controller"
  role   = aws_iam_role.lb_controller.id
  policy = file("${path.module}/policies/aws-load-balancer-controller.json")
}

resource "helm_release" "lb_controller" {
  name       = "aws-load-balancer-controller"
  repository = "https://aws.github.io/eks-charts"
  chart      = "aws-load-balancer-controller"
  version    = local.lb_controller_version
  namespace  = "kube-system"

  # Two Fargate pods have to be scheduled, pull their image through the NAT
  # gateway and pass their probes. The five-minute default is usually enough
  # and occasionally is not.
  timeout = 600

  values = [yamlencode({
    clusterName = aws_eks_cluster.main.name

    # Not optional on Fargate. The controller's fallback is to ask the
    # instance metadata service which region and VPC it is in, and a Fargate
    # pod has none — it crash-loops on "failed to introspect region".
    region = var.aws_region
    vpcId  = aws_vpc.main.id

    serviceAccount = {
      create = true
      name   = local.lb_controller_service_account
      annotations = {
        "eks.amazonaws.com/role-arn" = aws_iam_role.lb_controller.arn
      }
    }

    # Off, and not for tidiness. Left on, the chart registers a webhook that
    # every Service creation in the cluster must pass, with failurePolicy
    # Fail — so in the minute between this release starting and its pods
    # being ready, creating the app's Service is refused with "failed calling
    # webhook mservice.elbv2.k8s.aws". Its only purpose is to claim Services of
    # type LoadBalancer, and this stack has none.
    enableServiceMutatorWebhook = false
  })]

  depends_on = [
    # Cluster DNS, or the controller cannot resolve the AWS APIs it calls.
    aws_eks_addon.coredns,
    aws_iam_role_policy.lb_controller,
    # Fargate reads the logging ConfigMap when a pod starts and never again,
    # so it has to be there first or these two pods run without logs.
    kubernetes_config_map_v1.aws_logging,
  ]
}
