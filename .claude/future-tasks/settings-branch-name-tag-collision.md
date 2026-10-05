# Bare branch names a same-named git tag can shadow (sweep)

## Priority: P2 [BOTH] — one silent case; needs an adopter tag named exactly like a branch

Found 2026-10-05 by review rounds 2-4 of the settings re-provision fix; each behaviour below was
verified by running against git 2.55.

## The class

Git resolves a bare name to `refs/tags/<name>` before `refs/heads/<name>` in `fetch`, `rev-parse`,
`rev-list` and `ls-tree`, and `rev-parse --abbrev-ref HEAD` prints `heads/<name>` beside a
same-named tag. Workspace clones import every tag, and the worker's `remote.git` is a bare clone of
GitHub. The settings path is converted: provisioning's lookups, `pullCurrentBranch` and
`GitManager.push()` all name `refs/heads/<name>`.

## Sites still using bare names

- **`GitManager.hasUnpushedCommits` (silent).** Its `rev-parse --verify <name>` and
  `fetch <remote> <name>` both resolve the tag, so with an unpushed commit on the branch it can
  answer false; `services.ts` `submitBranch` then skips `push()` on a retry and reports success,
  every time. Nothing is lost locally. Fix: default from `currentBranchName()` and use
  `refs/heads/<name>` in both calls; test with a same-named tag and an unpushed commit.
- `GitManager.pullBase`, `rebaseOntoBase`, `checkoutBranchInner`: `fetch <remote> <baseBranch>`.
- Worker: `worker/git-sync.ts` `pushSettingsBranches` (`git.push(githubUrl, settingsBranch)`) and
  `worker/task-runner.ts` `pushBranchToGitHub` (`git.push(githubUrl, branch)`, and the
  `${branch}:${branch}` lease refspec). These fail loudly ("src refspec matches more than one"),
  so the branch never reaches GitHub; `remote.git` keeps it.

## Related, low

- `pullCurrentBranchInner` reads `branch().current` without `currentBranchName()`'s guard: on a
  detached HEAD (`current` is a short SHA) or mid-rebase (`current` is `"(no"`) the fetch fails
  "couldn't find remote ref" and is classified as never-pushed. The settings workspace never
  rebases, and `push()` then refuses, so a save returns `pushed: false`.
- Mid-rebase, `branch()` reports `detached: false` and `current: "(no"`, so `push()` fails in
  git rather than at its own guard. `git symbolic-ref --quiet HEAD` exits 1 on a detached HEAD and
  mid-rebase, and on an unborn branch still names it (the push then fails in git), so it could
  replace `branch()` there.
