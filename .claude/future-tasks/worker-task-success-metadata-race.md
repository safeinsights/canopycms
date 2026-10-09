---
priority: P3
adopters: NEITHER
summary: >-
  The worker's `updateBranchMetadata` (worker/task-runner.ts) reads branch.json with `loadOnly`, decides whether the branch is terminal (archived, or PR merged/closed), then saves `pullRequestState: 'open'` in a separate locked write; the git-sync loop can archive the branch between the two. Now that `BranchMetadataFileManager.saveIf` exists, fold the check into the write
---
# Worker task success writes `pullRequestState: 'open'` outside the check that guards it

`updateBranchMetadata` in `packages/canopycms/src/worker/task-runner.ts` runs after a PR task
succeeds. It reads branch.json with `BranchMetadataFileManager.loadOnly`, skips setting
`pullRequestState: 'open'` when the branch is already archived or its PR merged or closed, and
then calls `save()`. The read is outside the branch.json lock, and the git-sync loop runs
concurrently (see the module comment), so a merge-poll that archives the branch between the
read and the write is overwritten back to `open`.

`BranchMetadataFileManager.saveIf` evaluates a predicate against the version the write is
checked against. Split the update: save the always-applied fields, and apply
`pullRequestState: 'open'` through `saveIf` with the terminal check as the predicate, or move
the whole update into one `saveIf` whose predicate never refuses but whose update depends on
it (that needs an updater-shaped API, so prefer the split). Add a test that archives the
branch from inside the predicate's window.

Found while adding `saveIf` for adopter request 97
([resolved/empty-submit-and-remote-delete.md](resolved/empty-submit-and-remote-delete.md)).
