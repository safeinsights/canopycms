---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-08. Dev-mode init adds a temporary `__canopycms_init_*` remote to the source repo and removes it in a `finally` that ignores errors, so killed or failed runs leave strays (3 found in this repo). Push by path instead, with no named remote
---
# Dev-mode init can leave a temporary remote in the source repo's git config

## Priority: P3 [BOTH]

## The gap

`GitManager.pushBranchToLocalRemote` (`git-manager.ts`) adds a remote named
`__canopycms_init_<timestamp>__` to the source repo, pushes the base branch into the local bare
remote, then removes the remote in a `finally` that ignores errors. A process killed mid-push, or a
`removeRemote` that fails (for example on a locked `.git/config`), leaves the remote behind. The
source repo is the developer's own checkout, and in dev mode the adopter's. Measured 2026-10-08:
three stale ones in this repo's shared `.git/config`, from March and June 2026, two pointing at
`apps/example1/.canopy-dev/remote.git` and one at a deleted temp dir.

The two June strays point at example1's dev server seeding from the monorepo. The March one points
at a `canopycms-branchws-*` temp dir, the prefix `branch-workspace.test.ts` uses. So that suite's
seeding once ran with this real checkout as its source repo, not a temp repo. Check that its
isolation holds now.

## Suggested shape

Push by path, with no named remote: `git push --no-verify <remotePath> <refspec>`. That needs no
config write and no cleanup. Then drop the `finally`. Developers can remove existing strays with
`git remote remove <name>`.
