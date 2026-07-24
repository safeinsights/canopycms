# Settings-branch git ops (pull/commit/push) are not cross-host serialized

Found by the human review of PR #149 (2026-07-24, LOW — "adjacent cross-host risk
the file-lock doesn't close"). Already acknowledged in docs/concurrency.md's settings
row ("commit+push stays outside the lock"); this task tracks actually closing it or
formally accepting it.

## Problem

`mutateSettingsJsonFile` protects the working-tree *file write* with the layered
lock stack, but the subsequent `pullCurrentBranch()` merge + `git add/commit/push`
(api/settings-helpers.ts → services.ts `commitToSettingsBranch`) run outside any
cross-host lock against the shared settings clone on EFS. Two hosts (e.g. two Lambda
containers) driving concurrent git operations on the same `.git` can interleave —
git's own index.lock gives partial protection (a loser errors rather than corrupts),
but the pull→commit→push sequence is not atomic across hosts, so one host's push can
land between another's pull and push (push rejected, surfaced as `pushed: false`).

## Options

1. Extend a cross-host lock (e.g. `withOccFileLock` on a `.git-ops.lock` sibling of
   the settings root, like `.settings-init.lock`) around the pull→commit→push
   sequence. Cheap, bounded, matches the existing init-lock pattern.
2. Formally accept: document that a lost push race surfaces as `pushed: false` with
   retry-on-next-save semantics, and verify the editor surfaces that state.

## Where to look

- `packages/canopycms/src/authorization/settings-file-store.ts` — lock scope ends at file write
- `packages/canopycms/src/api/settings-helpers.ts` — commit orchestration
- `packages/canopycms/src/services.ts` — `commitToSettingsBranch` (scoped `git add <file>`)
- `packages/canopycms/src/settings-workspace.ts` — `.settings-init.lock` precedent
- `docs/concurrency.md` — settings row documents the current boundary
