---
priority: P2
adopters: BOTH
summary: >-
  New 2026-10-05. Where content history already leaked under the settings name, settings provisioning now fails closed, but the worker's tracked-branch promotion and settings push can recreate the branch on whichever side an operator deleted it. Check before pushing or promoting, and document recovery
---
# The worker restores a leaked settings branch after an operator deletes it

## Priority: P2 [BOTH]

Found 2026-10-05 by review round 1 of the settings-branch-not-content fix; by reading, not run.

Settings provisioning now refuses a remote settings branch that holds content
(`SettingsBranchHasContentHistoryError`), so a deployment where content history already leaked
under the settings name fails closed until an operator removes it. Removing it may not stick:
`reconcileTrackedBranches` (`worker/git-sync.ts`) creates a local head in `remote.git` from the
GitHub tracking ref and never deletes one, and `pushSettingsBranches` pushes the worker's own
settings branch to GitHub whenever it exists locally. Deleting it on only one side may therefore
see it recreated from the other within one sync cycle.

**Fix:** have `pushSettingsBranches` (and the tracked-branch promotion for the own settings name)
run the same content check before pushing or promoting, and warn instead. Then document the
recovery steps next to the error.
