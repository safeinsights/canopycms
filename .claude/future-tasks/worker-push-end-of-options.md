---
priority: P3
summary: >-
  Worker's plain `git.push(<url>, branch)` has no `--end-of-options` separator at three sites (`task-runner.ts:580,605`, `git-sync.ts:209`); the leased force push at `task-runner.ts:574` already passes it — argument-injectable in principle, low exposure since branch names originate from the CMS's own workflow. It was simply never back-applied. Its batch partner `efs-tls-in-transit` is resolved
---
# Worker git push: add `--end-of-options` before the branch name

**Priority: P3 [BOTH].** Low exposure, cheap hardening.

Three plain `git.push(<url>, branch)` sites pass a branch name straight through to `git push` with
no separator: `worker/task-runner.ts:606` (unleased push) and `:629` (the stale-lease retry), both in
`pushBranchToGitHub`, and `worker/git-sync.ts:201` (`pushSettingsBranches`). The leased force push in
the same function (`task-runner.ts:600`) already passes `--end-of-options` and is the pattern to
copy. A branch name crafted to look like a flag (starting with `--mirror` or `--delete`) would be
argument-injected into the invocation.

Branch names come from the CMS's own branch-creation workflow, not arbitrary external input, so
exposure is low; the task payload is still one hop removed from the git invocation.

## Fix

Route the three sites through `git.raw(['push', '--end-of-options', githubUrl, 'branch:branch'])`
as the leased push does (with the real branch interpolated), consistent with the argument-safety pattern
used elsewhere for branch names (see the `GitManager branch name argument safety (SEC-H2)` tests in
`git-manager.test.ts`).
