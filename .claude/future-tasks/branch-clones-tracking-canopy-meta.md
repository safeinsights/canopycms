# Branch clones still tracking `.canopy-meta/` after the adopter untracks it

Found 2026-10-04 in review of the `.canopy-meta` sync fix. **Needs a design decision before code.**

## Problem

When an adopter's repo tracks `.canopy-meta/` and the branch clone has modified tracked state
there (canopycms rewrites `branch.json` and `comments.json` continuously), `git rebase` refuses
to start. The worker records a `rebaseFailure` and skips the branch on every cycle. That stays
true after the adopter runs `git rm -r --cached .canopy-meta` upstream: the clone's own index and
history still track the files. The base clone follows the adopter's fix on its next successful
fast-forward, because it has no commits of its own (`untrackInIndex` before the merge). Branch
clones do not.

## The obvious fix loses data. Do not ship it

The first attempt untracked the paths in the branch clone's index, committed that change, and let
the rebase drop the commit as already upstream. Review reproduced two defects in it:

1. **Data loss.** Branches submitted before the fix carry commits that touched `.canopy-meta/`,
   because the old submit ran `git add .`. Replaying one of those commits hits a modify/delete
   conflict, and git writes that commit's historical bytes over the live file. The worker resolves
   the conflict with `git add`, which fails with "paths are ignored". It then runs `rebase --abort`,
   which resets to the untracking commit and deletes the file from disk. The branch status, ACLs,
   PR number and comments are lost, every cycle. This is reproduced by the
   "leaves the index and the bytes alone" test in `worker/cms-worker-rebase.test.ts`.
2. **[SYNC-H1] wedge.** The extra commit becomes `preRebaseHead`, so for an already-published
   branch `carryForwardRewrittenHistory` sees remote.git's tip differ from it, and refuses to arm the
   force publish. The editor's next submit is then rejected non-fast-forward.

## Constraints for a real fix

- Only consider auto-repair when no commit in `merge-base..HEAD` touches `.canopy-meta/`. Otherwise
  record the failure for an operator.
- If a commit is made, the pre-commit HEAD must be what `reconcilePendingRewrite` and
  `carryForwardRewrittenHistory` see. On every exit where the rebase did not complete, undo the commit
  with `reset --soft HEAD~1`, or it ships in the editor's PR.
- Resolve DU/UD conflicts on `isCanopyInternalPath` paths without `git add`, and never let git write
  historical bytes over a live state file. Snapshot and restore under the branch.json/comments
  lockfiles if bytes must move.
- An operator runbook (purge and re-provision, after saving the branch's work) may be the better
  answer than code, given how rare this population is once submit stops committing the state.

## Related, pre-existing

A base-branch commit that ADDS a tracked file under `.canopy-meta/` silently overwrites the live,
excluded copy when a clone fast-forwards or rebases onto it, because git treats ignored files as
expendable. Reproduced with git 2.55 in review. The tracked-state warning reports the path on the
next cycle, but by then the live bytes are gone.
