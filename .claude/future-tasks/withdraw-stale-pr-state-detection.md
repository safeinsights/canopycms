# Withdraw uses metadata-cached `pullRequestState` for closed-PR detection

Found by the human review of PR #149 (2026-07-24, LOW). Deferred: cosmetic, self-heals.

## Problem

`api/branch-withdraw.ts` decides "was this PR closed on GitHub?" from
`branchContext.branch.pullRequestState`, which is only as fresh as the worker's last
merge-poll cycle (up to `gitSyncInterval` stale). If a PR is closed on GitHub and the
user withdraws before the next poll runs, the handler still sees `'open'`, so it
enqueues a `convert-to-draft` task that fails permanently on GitHub's side (422 —
can't draft a closed PR) and trips `syncStatus: 'sync-failed'` on a branch that
actually withdrew successfully.

## Why deferred

- The withdraw itself succeeds; only the sync-status badge is misleading.
- It self-heals on the next edit/submit cycle.
- A real fix means either querying GitHub synchronously in the withdraw handler
  (adds a network dependency + latency to an editor action, and the Lambda has no
  internet in prod — it would have to go through the task queue anyway) or teaching
  the convert-to-draft task to treat "PR already closed" (422) as a benign no-op
  instead of a permanent failure. The second is the better shape.

## Suggested fix

In the worker's convert-to-draft task handler, catch the GitHub 422/closed-PR error
and complete the task successfully (log it), rather than failing and setting
`sync-failed`. Optionally have that path also stamp `pullRequestState: 'closed'` so
metadata converges early.

## Where to look

- `packages/canopycms/src/api/branch-withdraw.ts` — `wasClosed` detection
- `packages/canopycms/src/worker/cms-worker.ts` — convert-to-draft task execution
- `packages/canopycms/src/api/github-sync.ts` — `syncConvertToDraft` dual path
