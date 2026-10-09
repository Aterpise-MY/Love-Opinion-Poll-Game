resource "aws_ecr_repository" "app" {
  name = local.name

  # Immutable tags mean a tag can never be repointed at different bytes, so
  # the Deployment's image reference is a real record of what ran. It is also
  # why nothing here ever pushes `:latest` — the two are incompatible.
  image_tag_mutability = "IMMUTABLE"

  # Without this, `terraform destroy` fails on a repository that still has
  # images in it.
  force_delete = true

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = local.tags
}

# Counted, not aged. An image that is still running must never be the one that
# expires, and "the newest five" holds that for as long as deploys keep
# succeeding, however far apart they are — an age rule would delete the only
# image of a stack left alone for a month.
#
# The count is what bounds a rollback, though, and two things can reach past
# it. Five pushes in a row that each fail to roll out leave the image the
# pods are still running in sixth place. And `terraform apply` with an old
# image_tag — `deploy.sh --no-build` reads the tag from state, which knows
# nothing of what CI has pushed since — names an image that may be gone.
# Either way the symptom is ImagePullBackOff the next time a pod starts.
resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name

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
