---
name: Taskboard item
about: Plan and track a feature, bug, or independently deliverable task
title: "[Task]: "
labels: []
assignees: []
---

## Summary

<!-- Describe the requested outcome clearly. -->

## User Value

<!-- Who benefits, what problem is solved, and why does it matter? -->

## Requirements

- [ ] Requirement 1
- [ ] Requirement 2

## Acceptance Criteria

- [ ] Criterion 1 is observable and testable.
- [ ] Criterion 2 is observable and testable.

## Out of Scope

<!-- List related work this issue must not include. -->

## Dependencies and Risks

<!-- Link blockers and note migrations, security concerns, compatibility risks, or external dependencies. -->

## Milestone

<!-- Link the matching milestone. Search before creating a new one. -->

## Ownership Split

The Orchestrator plans and approves; it writes no code. Add one row per roster agent that takes part, in the order the tasks run.

| Order | Agent | Task | Owned paths it will change | Contract it returns |
| --- | --- | --- | --- | --- |
| 1 | <!-- roster agent --> | <!-- one task --> | <!-- paths from the roster --> | <!-- schema, API, or none --> |

- Task slug: <!-- <issue-number>-<short-description> -->
- Branch: <!-- feature/<task-slug> -->
- Worktree: <!-- worktrees/<task-slug> -->
- Work no roster agent owns: <!-- ask the HR Manager to hire, or write "none" -->

## Implementation Plan

- [ ] Confirm requirements, scope, and acceptance criteria with the user.
- [ ] Find or create the milestone and link this issue.
- [ ] Create the worktree and branch off `master`.
- [ ] Delegate each task to the agent that owns the files, with a complete brief.
- [ ] Run the approval loop on every deliverable (at most 3 rounds per task).
- [ ] Confirm no agent changed files outside the paths it owns.

## Validation Evidence

### Approval loop

| Agent | Rounds | Outcome |
| --- | --- | --- |
| | | |

### Local run

- Test command: `npm test`
- Commands and results:
- Start command: `npm run dev --prefix frontend`
- How the change was exercised:
- Tested commit SHA:
- [ ] The user gave the OK to open the staging pull request for this exact commit.
- Approval reference:

### Staging

- Pull request into `master`:
- [ ] The pull request was merged by the user.
- Deployed commit SHA:
- Staging verification result:
- [ ] The user confirmed promotion to production.
- Approval reference:

### Production

- Pull request from `master` into `master`:
- [ ] Included issues and commits were listed for the user.
- [ ] The pull request was merged by the user.

## Deployment and Rollback

<!-- Add migrations, configuration, monitoring, and rollback steps. Write "Not applicable" when appropriate. -->

## Completion Checklist

- [ ] Acceptance criteria are satisfied.
- [ ] Every agent stayed inside the paths it owns.
- [ ] Tests pass with zero failures and zero errors.
- [ ] The user's OK before the staging pull request is recorded for the tested commit.
- [ ] Both pull requests were merged by the user; no agent merged anything.
- [ ] Staging verification is recorded.
- [ ] Documentation was updated.
- [ ] Follow-up work was opened as linked issues.
- [ ] The worktree and merged branch were removed.
- [ ] Issue and milestone status were updated.
