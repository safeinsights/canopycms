---
'canopycms': minor
'canopycms-cdk': minor
---

### Archived branches move out of the way, with optional retention

<!-- migration
area: Branches
action: Optional
row: Set archivedBranchRetentionDays to delete merged branches by age
-->

**What changed.** The branch list shows live branches first, newest first, then a collapsed "Archived (n)" section, with a filter box past 10 branches. A pull request closed without merging shows a "PR closed" badge, and an admin can archive that branch without recording a merge (`POST /:branch/archive`). System health gains "Delete merged archived branches older than N days". The new `archivedBranchRetentionDays` prop on `CanopyCmsService` (`CANOPYCMS_ARCHIVED_BRANCH_RETENTION_DAYS` on the worker), off by default, has the worker delete merged branches' workspaces and comments that many days after archiving. Neither way touches a GitHub branch, a branch archived without merging, or one that may hold unpublished commits.

**To adopt.** Nothing is required. To turn retention on, set `archivedBranchRetentionDays` on `CanopyCmsService` to a whole number of days and deploy the stack.
