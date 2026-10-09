---
priority: P3
adopters: NEITHER
summary: >-
  The submit handler (api/branch-status.ts) enqueues the worker's PR task before it saves `status: 'submitted'`, `submittedAt` and `syncStatus: 'pending-sync'`. A worker that fails the task before that save lands has its `sync-failed` reason (and the empty-submit unlock) overwritten, leaving a locked branch with no reason. Save the submitted state before enqueueing
---
# The submit handler saves the submitted state after the worker's task is already queued

In `packages/canopycms/src/api/branch-status.ts`, `submitBranchForMergeHandler` calls
`syncSubmitPr` (which enqueues `push-and-create-or-update-pr` on the worker path) and only then
saves `status: 'submitted'`, `submittedAt`, `syncStatus` and `syncFailureReason: undefined`.

If the worker dequeues, pushes and fails the task permanently before that save lands:

- the empty-submit unlock in `updateBranchMetadataOnFailure` (worker/task-runner.ts) sees
  `editing` and a different `submittedAt`, so it declines and writes a plain `sync-failed`;
- the handler's save then sets `submitted` and `pending-sync` and erases the reason.

The branch ends locked, showing "Syncing…", with no reason. The window is the handler's
metadata save against a worker poll plus a GitHub push, so it is narrow, and the same ordering
already let a fast permanent failure of any kind be overwritten before request 97.

Fix shape: save the submitted state (`status`, `submittedAt`, `syncStatus: 'pending-sync'`,
cleared reasons) before enqueueing, and afterwards save only what the enqueue or direct call
produced, never `syncStatus` on the queued path. The direct path's 400 for "nothing to submit"
then has to return the branch to `editing` in its second save. Test by making the stub worker
fail the task synchronously inside `enqueueTask`.

Found in review of adopter request 97
([resolved/empty-submit-and-remote-delete.md](resolved/empty-submit-and-remote-delete.md)).
