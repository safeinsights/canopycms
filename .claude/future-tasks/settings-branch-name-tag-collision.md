# A git tag named after the settings branch breaks settings saves

## Priority: P3 [BOTH] — needs an adopter tag named exactly like the settings branch

Found 2026-10-05 by review round 2 of the settings re-provision fix; verified by running against
git 2.55.

## What happens

Git resolves a bare name to `refs/tags/<name>` before `refs/heads/<name>`, and both the workspace
clone and the worker's `remote.git` carry tags. With a tag named like the settings branch (for
example `canopycms-settings-prod`):

- `GitManager.pullCurrentBranch` fetches the bare name, gets the tag, and the merge fails with
  "refusing to merge unrelated histories". Every settings save fails, loudly. A test in
  `git-manager.test.ts` pins that it stays loud.
- `GitManager.push()` takes the branch from `rev-parse --abbrev-ref HEAD`, which prints
  `heads/<name>` when a same-named tag exists, so the push would create `refs/heads/heads/<name>`
  on the remote. Only the loud pull failure above stops a save from getting this far; switching
  the pull to `refs/heads/<name>` alone turns the failure into silently lost settings.
- The worker's settings push (`worker/task-runner.ts`, `git.push(githubUrl, branch)`) fails with
  "src refspec matches more than one".

Provisioning already resolves the settings branch by full ref (`fetchBranchTip`,
`isEmptyInitialBranch`, `reconcileLocalSettingsBranch`), so it is unaffected.

## Options

- Refuse at provisioning: when `ls-remote` or the workspace shows `refs/tags/<settings branch>`,
  throw a clear error naming the tag. Smallest change, and it surfaces in System Health.
- Or move every settings-branch git call to full refs together: the pull's fetch, `push()`'s
  refspec (`symbolic-ref --short HEAD`, then `refs/heads/X:refs/heads/X`), and the worker push.
  Test: tag in `remote.git` before the clone, save twice, assert `refs/heads/<branch>` on the
  remote holds both saves.
