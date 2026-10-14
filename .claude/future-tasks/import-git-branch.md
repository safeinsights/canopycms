---
priority: P2
adopters: BOTH
summary: >-
  A branch made with plain git is mirrored into `remote.git` but gets no workspace or `branch.json`, so editors can neither see nor edit it. Proposed: an admin action that imports such a branch's content changes into a new Canopy branch, never adopting the git branch itself
---
# Import a git-made branch into the editor

## Priority: P2 [BOTH]

## Problem

The editor lists only workspaces that carry `.canopy-meta/branch.json` (`branch-registry.ts`
`scanBranchDirectories`). The worker mirrors every GitHub branch into `remote.git`
(`worker/git-sync.ts` `reconcileTrackedBranches`) but provisions nothing for it, every
`/:branch/...` route answers 404 for it (`api/guards.ts`), and creating a Canopy branch with the
same name is refused 409 once the mirror has it (`api/branch.ts`). `adoptInPlace` exists for dev
only. So content a developer parks on a git branch (the marketing site's `qa/blog-parked-posts`
holds two posts awaiting publication) cannot be touched in the editor before it merges.

## Proposed design

Import, never adopt in place. Adopting would put a developer's branch under the worker's rebase and
force-push-with-lease, diverging their clone, and would contradict
[gateway-cms-branch-namespace.md](gateway-cms-branch-namespace.md)'s "Canopy writes only branches
it owns". The new branch is Canopy-owned, so it fits any outcome of that decision.

- Admin-only `POST /branches/import { source, branch, title? }`: provision a normal branch from base
  (`provisionBranch`), fetch `refs/remotes/github/<source>` from `remote.git` by explicit refspec,
  and apply `git diff --binary <merge-base> <source> -- <contentRoot>` with `git apply --3way`.
- On a conflict the source's version wins, matching the rebase rule, and the IDs go into
  `conflictFiles`. Commit `Import content from <source>` with an `Imported-from: <source>@<sha>`
  trailer; the branch is `editing`.
- Refuse symlink and gitlink entries. Report paths outside the content root as not imported; when
  the content root is the repository root, take only entry files and `.collection.json`. An
  imported `.collection.json` bumps the schema marker under `withBranchSchemaLock`.
- The source branch and its PR are left alone; the dialog says to close the source PR once the
  import is submitted.

Smallest first version: the endpoint and a minimal admin dialog that takes a branch name. Later: a
`GET /branches/importable` listing that excludes base, settings and registry names, other
deployments' Canopy branches (tips authored by the bot or carrying `Edited-by` trailers) and
content-free refs; and dev mode, whose simulated remote is a one-commit snapshot of `sourceRoot`
with no shared history, so the diff is computed in the source repo with the subdirectory prefix
stripped.

## Trigger

An editor needs to change content that exists only on a git-made branch before it is published.

## Related

- [content-lifecycle-scenarios.md](content-lifecycle-scenarios.md)
