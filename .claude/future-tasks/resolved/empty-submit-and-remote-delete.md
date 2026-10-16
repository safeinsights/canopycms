---
adopters: BOTH
summary: >-
  RESOLVED 2026-10-09, branch `fix/empty-submit-and-remote-delete`, base `int-202610-b` — adopter request 97. Submit refuses a branch whose saved content matches its base (400 "Nothing to submit yet", checked under the content-write lock before anything is pushed, undoing the submit's own commit); GitHub's 422 "No commits between" is recognized on both the direct and worker paths, and the worker returns the failed submit to editing with the reason; every sync failure's reason shows on the branch row; and delete removes the GitHub branch whenever the CMS pushed it there (`pushedToGitHubAt`), not only when a PR number was recorded.
---
# Submitting a branch with no changes is accepted, then fails permanently in the worker

**Status: RESOLVED 2026-10-09**, branch `fix/empty-submit-and-remote-delete`, base
`int-202610-b`. Adopter request 97.

## Problem

An editor submitted a branch with nothing saved on it. The API committed nothing, pushed the
branch at its base commit, and marked it `submitted`. The worker pushed it to GitHub, GitHub
refused the PR with 422 "No commits between …", and the task failed permanently. The author
saw "Branch submitted for review", then a bare "Sync failed" badge (the reason sat in a
tooltip), and a locked branch they had to withdraw. Deleting the branch then left it on
GitHub, because remote delete took a recorded PR number as its only proof that the CMS had
pushed the branch.

## What "changes" means

The branch's **saved** content, committed or not, outside `.canopy-meta/`, compared with its
base at the fork point: after Submit's own commit, `git diff <base-tip>...HEAD` is non-empty.
Unsaved edits in the browser never count, since Submit has never sent them. This is a content
diff, not "commits ahead", so saved edits that restore the base content are refused too.

## What shipped

- `services.submitBranch` lists the changed paths after committing and before pushing. When
  the list is empty it resets to the SHA it read before committing (git's commit can succeed
  without committing, so never `HEAD~1`) and throws `NothingToSubmitError`; the handler answers
  400. If the list cannot be computed, the submit goes through as before.
- `isNoCommitsBetweenError` (github-service.ts) matches the 422 on `errors[].message`, falling
  back to Octokit's folded message; no other 422 matches. Tests build the error by running a
  real Octokit request through a stub fetch.
- The direct path answers the same 400 without locking the branch. The worker raises
  `NothingToSubmitTaskError`, and `BranchMetadataFileManager.saveIf` returns the branch to
  `editing` only while it is still `submitted`, has no PR, and carries the `submittedAt` the
  task was queued with, so a late failure never unlocks a newer submit.
- `syncFailureReason` is shown on the branch row, with a withdraw hint while still submitted,
  and the direct path now records one too.
- `pushedToGitHubAt` is stamped when GitHub accepts a worker push (whatever the PR call does
  next) or by a direct-path submit. Delete accepts it as proof alongside the PR number, and the
  worker's delete task skips a reused name whose stamp differs. Metadata written before this
  change has no stamp, so a PR-less branch from then is left alone on GitHub, as before.
- Follow-ups filed: [submit-saves-after-enqueue.md](../submit-saves-after-enqueue.md),
  [worker-task-success-metadata-race.md](../worker-task-success-metadata-race.md),
  [system-health-retry-advice-for-permanent-failures.md](../system-health-retry-advice-for-permanent-failures.md).
