---
priority: P3
adopters: BOTH
summary: >-
  System health's branch list appends "— retry from the Tasks tab" to every recorded sync failure reason, including permanent ones a retry cannot fix (a diverged push, a workflow-file refusal, GitHub finding nothing to submit). Say "retry" only for failures a retry can fix
---
# System health advises a retry for sync failures a retry cannot fix

`packages/canopycms/src/editor/admin/SystemHealthPanel.tsx` renders a branch's
`syncFailureReason` followed by "— retry from the Tasks tab". The worker records a reason only
when a task fails for good, and many of those are permanent by classification
(`PermanentTaskError` in `worker/task-runner.ts`): a non-fast-forward push, a push refused for
workflow content, and GitHub answering "No commits between" for a submit. Retrying any of them
fails identically, and for the last the branch is usually already back in editing.

Decide how the panel learns which failures are retryable. Options: record a `retryable` flag
alongside `syncFailureReason` when the task fails (the runner already computes `permanent`),
or drop the advice and let the Tasks tab's own retry control speak for itself. Keep the change
small; a nearby System health status is being added separately, so expect a merge there.

Found while fixing adopter request 97
([resolved/empty-submit-and-remote-delete.md](resolved/empty-submit-and-remote-delete.md)).
