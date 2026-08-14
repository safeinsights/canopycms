# Submit retry after commit-succeeded/push-failed silently skips the push

## Priority: P2

Found 2026-07-30 by the canopy-hardening epic's independent review (PR #183),
while tracing the stale-mirror-head 409 (fixed on the epic). This half is
PRE-EXISTING, not introduced by the epic, and survives its fixes.

## Problem

`services.ts`'s `submitBranch` only commits AND pushes when the working tree
is dirty:

```ts
const status = await git.status()
if (status.files.length > 0) {
  await git.add('.')
  await git.commit(...)
  await git.push(options.context.branch.name)
}
```

If the commit succeeds but the push to `remote.git` fails (non-fast-forward
collision, EFS hiccup, lock contention), the user sees the submit error
(now a 409/500). On RETRY, the tree is clean — `status.files.length === 0` —
so the push is SKIPPED entirely, and the handler proceeds to `syncSubmitPr`,
which enqueues the worker push task. The worker then pushes `remote.git`'s
`refs/heads/<branch>` — which never received the commit — to GitHub. Outcome:
a PR is created/updated WITHOUT the user's latest edits, everything reports
success, and `syncStatus` lands `synced`. The edits still sit in the branch
clone on EFS, so a later unrelated dirty-tree submit would ship them — but
until then the PR content is silently stale.

## Fix sketch

Push when the branch clone is AHEAD of `remote.git`'s head, not only when the
working tree is dirty — e.g. compare `rev-parse HEAD` against the mirror's
`refs/heads/<branch>` (or always push; a no-op push is cheap and exits 0).
Add a regression test: submit → fail the push (seed a diverged mirror head) →
retry after the mirror is fixed → assert the commit reaches `remote.git`.

## Related

- `packages/canopycms/src/services.ts` (`submitBranch`)
- `packages/canopycms/src/api/branch-status.ts` (submit handler, 409 path)
- Epic fix that removes the main trigger: `deleteBranchHandler` now deletes
  the stale mirror head (`GitManager.deleteBareRemoteHead`), so the
  create→publish→squash-merge→delete→reuse cycle no longer produces the
  colliding mirror head that made this retry path likely.
