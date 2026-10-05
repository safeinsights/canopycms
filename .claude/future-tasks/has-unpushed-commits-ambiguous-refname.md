# `hasUnpushedCommits` resolves a short name, so a same-named tag hides an unpushed branch

## Priority: P3

## The defect

`GitManager.hasUnpushedCommits` (`packages/canopycms/src/git-manager.ts`) resolves
the branch with `rev-parse --verify --end-of-options <name>` and fetches it with
`fetch --end-of-options <remote> <name>`. Both take a short name. When the repo
holds a tag with the same name as the editing branch, both resolve to the tag
(gitrevisions order puts `refs/tags/` ahead of `refs/heads/`). Measured on git
2.55: rev-parse warns "refname is ambiguous", and fetch reports
`* tag <name> -> FETCH_HEAD`.

Both sides then hold the tag's SHA, so `fetchedTip === localSha` and the
method returns `false` while the branch itself is ahead.

## When it fires

`services.ts:320` `submitBranch` calls `hasUnpushedCommits` only when there was
nothing to commit. The failing case is a clean-tree retry after a failed push.
The first attempt does fail loudly: `push` of `<name>:<name>` dies with "src
refspec <name> matches more than one". The retry then reports success without pushing.
It needs an adopter repo with a tag named like a sanitized CMS branch, so it is
unlikely.

## Fix

Resolve `refs/heads/<name>` in the rev-parse and fetch `refs/heads/<name>`, as
the `worker/` rev-parse sites already do (`history-rewrite.ts:53`, `cms-worker.ts:493`).
`push()` takes a short name too and is worth the same look. Add a real-git test
with a same-named tag on both the clone and the remote.
