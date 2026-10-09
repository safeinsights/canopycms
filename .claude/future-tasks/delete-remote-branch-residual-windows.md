---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-07. Deleting a branch on GitHub leaves two narrow windows. A double fault (a newer same-named branch whose PR number was never recorded) lets a stale delete close that branch's PR. A failed or late delete lets git-sync recreate the deleted branch's local head from the tracking ref
---
# Two narrow windows left around deleting a branch on GitHub

## Priority: P3

Found 2026-10-07 in review of the change that made Delete remove a CMS branch's GitHub branch
(`api/github-sync.ts` `syncDeleteRemoteBranch`, `worker/task-runner.ts` `delete-remote-branch`).

## 1. A reused name whose PR number never got recorded

The worker skips the GitHub delete when a live branch under the same name records a different
PR. If that newer branch's submit pushed and opened a PR, but the PR number never reached its
branch.json, the stale delete task proceeds. This happens when the worker dies between
`completeTask` and `updateBranchMetadata`, or when that `save` throws and the error is
swallowed. GitHub then closes the newer PR. It needs two faults: a lost metadata write, plus a
delete task still pending (in backoff, recovered as an orphan, or requeued by an admin).

Possible fix, on that rare path only: when a live branch.json has no PR number, ask GitHub
(`pulls.list` with `head: owner:branch`, `state: open`) and skip if an open PR other than the
deleted one exists. A remote.git-vs-GitHub SHA comparison does not work:
`reconcileTrackedBranches` recreates the local head from GitHub's tracking ref.

## 2. A failed or late delete lets the stale local head come back

`deleteBranchHandler` removes the branch's head from the local mirror but deliberately keeps
the GitHub tracking ref. If the GitHub branch is still there at the next git-sync cycle, the
worker's reconcile recreates `refs/heads/<name>` at the deleted branch's tip. That happens when
the delete task failed permanently, or is still retrying after a cycle. A same-named branch's
first submit then fails at the remote.git push. Once the GitHub delete succeeds, `fetch
--prune` removes the tracking ref, but a head recreated in the meantime stays.

Question: should a successful `delete-remote-branch` also remove the local head and the
tracking ref, so the outcome no longer depends on timing?
