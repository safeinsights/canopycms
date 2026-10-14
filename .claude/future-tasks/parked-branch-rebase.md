---
priority: P3
adopters: BOTH
summary: >-
  A branch with saved edits never rebases until it is submitted (the dirty check in `worker/rebase.ts` runs before the behind count), so a branch parked for weeks drifts from base and the drift surfaces only as a GitHub PR conflict. Proposed: rebase idle dirty branches through a transient checkpoint commit, and record how far behind each branch is
---
# Rebase parked branches that hold saved edits

## Priority: P3 [BOTH]

## Problem

Saves write only the working tree; the one commit is made at submit (`services.ts` `submitBranch`).
The rebase loop skips any branch with uncommitted changes (`worker/rebase.ts`, the `skippedDirty`
return), and it checks that before counting how far behind the branch is. So a branch that holds
any saved edit does not follow base for as long as it stays open, and the drift shows up only when
its PR is opened against a base that has moved.

The skip also protects open editor forms: saves are version-checked against the file's mtime
(`docs/concurrency.md`), and a rebase rewrites the mtime of every file the branch touched, so
rebasing a branch someone is editing turns their next save into "this entry changed since you
opened it".

Today's recovery, documented in README "Drafts and Unpublishing": withdraw the submitted branch,
whose tree is clean after the submit commit, let one worker cycle rebase it, and resubmit.

## Proposed design

- Rebase a dirty branch only when it is `editing`, behind base, and idle: no file `git status`
  reports dirty has an mtime newer than a threshold (default 24h, configurable). An active branch
  keeps today's skip.
- Step order: interrupted-rebase recovery → `restoreRetiredSchemaCache` → tracked-state refusal →
  history-rewrite self-heal → fetch and behind count → checkpoint → rebase → reset.
- The checkpoint is transient: commit the tree with a `Canopy-Checkpoint: true` trailer, rebase,
  then `reset --mixed` to the checkpoint's parent (skip the reset when the rebase dropped the
  checkpoint as empty). Edits stay uncommitted, so submit, `uncommittedEditors` and attribution are
  unchanged, and the force-publish arming guard (`rebase.ts`, `publishedSha === preRebaseHead`) and
  `reconcilePendingRewrite` keep comparing real commits.
- Crash self-heal: after recovery, a HEAD carrying the checkpoint trailer is reset. Submit resets
  one too before committing.
- Refuse to checkpoint when anything staged is a gitlink (mode 160000) or symlink (120000), and pin
  the commit identity rather than reading it from the Lambda-writable clone config. Review against
  [gateway-cms-branch-namespace.md](gateway-cms-branch-namespace.md)'s threat model.
- Record `behindBy` after each attempt and `lastCaughtUpAt` when a rebase lands or the branch
  catches up, through `update(..., { keepUpdatedAt: true })` and only when they change, and show
  "N changes behind" on the branch card and in System Health.

Rejected: `rebase --autostash` (a failed pop leaves conflict markers in content), and permanent
checkpoint commits (a submitted-then-withdrawn branch's `remote.git` tip no longer equals the
pre-rebase HEAD, so the arming guard records a false failure, and keying it differently would
force-publish unsubmitted work to the open PR).

## Trigger

An editor-made branch with saved edits stays parked for weeks, or an adopter whose editors cannot
use the withdraw-and-resubmit route.

## Related

- [content-lifecycle-scenarios.md](content-lifecycle-scenarios.md)
