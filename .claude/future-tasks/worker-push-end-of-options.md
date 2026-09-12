# Worker git push: add `--end-of-options` before the branch name

Flagged by PR #141 review (LOW). Pre-existing — out of PR #141's own diff.

## Problem

Three plain `git.push(<url>, branch)` sites pass a branch name straight
through to git's `push` with no `--end-of-options` separator:
`task-runner.ts:580` and `:605` (the unleased push and the stale-lease retry inside
`pushBranchToGitHub`) and `git-sync.ts:209` (`pushSettingsBranches`). The leased force
push at `task-runner.ts:574` already passes `--end-of-options` and is the pattern to
back-apply. A branch name crafted to
look like a flag (e.g. something starting with `--mirror` or `--delete`) would be
argument-injected into the `git push` invocation instead of being treated as a plain
branch name.

## Exposure

Branch names originate from the CMS's own branch-creation workflow (editors pick names
through the UI, not arbitrary external input), so exposure is low today. Still worth
hardening since the task payload is one hop removed from the actual git invocation.

## Fix direction

Insert `--end-of-options` (or `--`) between the remote and the branch argument in the
`git.push(...)` call so git stops parsing options at that point, consistent with the
argument-safety pattern already used elsewhere for branch names (see
`GitManager branch name argument safety (SEC-H2)` tests in `git-manager.test.ts`).
