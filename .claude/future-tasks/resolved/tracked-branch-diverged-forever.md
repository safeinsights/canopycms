---
priority: P2
summary: >-
  RESOLVED 2026-10-11, branch `fix/tracked-branch-stale-mirrors`, base `int-202610-b` (adopter
  request 110). The worker's tracked-branch reconcile moves a diverged `remote.git` head holding no
  editor state to GitHub's tip, and deletes the head of a branch GitHub no longer has under the same
  test (worker/stale-mirror.ts, leased, under the branch's provisioning lock). A head that does hold
  editor state stays `diverged`, is warned about once per (branch, local, GitHub) tips, and is listed
  in System health with what it means and what to do.
---

# Tracked-branch reconcile warns forever on a human force-push

**Status: RESOLVED 2026-10-11**, branch `fix/tracked-branch-stale-mirrors`; see the summary.

**Priority:** P2. **Found:** adopter request 110, on int.113 and earlier.

## Problem

`reconcileTrackedBranches` (worker/git-sync.ts) mirrors every GitHub branch into `remote.git`'s
`refs/heads/*`. A developer rebased and force-pushed an ordinary PR branch on GitHub, so the local
copy (the old tip) and GitHub's tip were no longer ancestors of each other. The branch was
classified `diverged` and never updated, and the worker logged the same warning every sync, about
470 lines over several days and four instance replacements, though the branch had no workspace,
no metadata and no queued push. Deleting the GitHub branch left an orphan head behind. System
health did not show `tracked.diverged`, and no operator could resolve it without a shell.

## What shipped

- **Stale copies follow GitHub.** A diverged head with no editor state (no workspace or anything
  else at its sanitized name, no queued or running push task, not the base or a settings branch)
  moves to GitHub's tip from the gateway fetch's ref map, leased on the old local SHA. The check
  and the update hold the branch's provisioning lock, zero-retry, so no workspace can be published
  in between.
- **Orphans are pruned** under the same test once GitHub's answer no longer names the branch,
  and only when it names the base branch.
- **Warn once** per (branch, local tip, GitHub tip), held on the worker instance, with the
  editor state that kept the head, and every name escaped.
- **System health** lists `tracked.diverged` with plain-language copy: what diverged means, and
  that purging the branch's directory (not deleting the branch, which can delete it on GitHub
  too) lets the worker take GitHub's version.
