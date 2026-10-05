# The worker's GitHub pushes resolve branch names that a same-named tag can shadow

## Priority: P3 [BOTH] — needs an adopter tag named exactly like a branch; fails loudly

Found 2026-10-05 by the review rounds of the settings re-provision fix; verified by running against
git 2.55.

## What happens

Git resolves a bare name to `refs/tags/<name>` before `refs/heads/<name>`, and the worker's
`remote.git` is a bare clone of GitHub, so it carries every tag. The API side is not affected:
`GitManager`'s settings fetches, its pull and `push()` all use `refs/heads/<name>`.

The worker's pushes from `remote.git` to GitHub still pass the bare name:

- `worker/git-sync.ts` `pushSettingsBranches`: `git.push(githubUrl, settingsBranch)`;
- `worker/task-runner.ts` `pushBranchToGitHub`: `git.push(githubUrl, branch)` and the
  `${branch}:${branch}` lease refspec.

With a same-named tag in `remote.git` the push fails ("src refspec matches more than one"), so that
branch never reaches GitHub and the worker logs a warning or fails the task. Nothing is lost:
`remote.git` keeps the branch.

## Fix

Push `refs/heads/<branch>:refs/heads/<branch>` at both sites, including the lease retry. Test: a
tag named like the branch in `remote.git`, then the push lands on GitHub's `refs/heads/<branch>`.
