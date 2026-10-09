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

## Suggested shape

Push by path, with no named remote: `git push --no-verify <remotePath> <refspec>`. That needs no
config write and no cleanup. Then drop the `finally`. Developers can remove existing strays with
`git remote remove <name>`.
