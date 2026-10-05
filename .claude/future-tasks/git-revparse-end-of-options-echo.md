# `hasUnpushedCommits` breaks on a pushed branch that is ahead: rev-parse echoes `--end-of-options`

## Priority: P1

Found 2026-10-04 while adding `GitManager.listChangedPathsSinceBase` (the submit
attribution PR), which hit the same behaviour and uses `--verify` to avoid it.

## The defect

`git rev-parse --end-of-options <rev>` without `--verify` prints the literal
`--end-of-options` line before the SHA (measured on git 2.55.0):

```
$ git rev-parse --end-of-options HEAD
--end-of-options
5824044ab5e8c26c493bfb477e3a6559447d4333
```

`GitManager.hasUnpushedCommits` (`packages/canopycms/src/git-manager.ts`, the
`localSha` and `fetchedTip` lines, plus the `--abbrev-ref` fallback above them)
uses exactly that form. `.trim()` keeps the embedded newline, so:

- `fetchedTip === localSha` still works when the two match, because both carry
  the same prefix. That is why the existing tests pass.
- When they differ, `git rev-list --count "<prefix>\n<sha>..<prefix>\n<sha>"`
  is called with a malformed range and exits 129 (measured). The method throws.

## When it fires

`services.ts` `submitBranch` calls `hasUnpushedCommits` only when there was
nothing to commit. So the failing case is a submit retry with a clean tree on a
branch that was pushed before and has local commits the remote lacks: an
earlier commit landed and its push failed, on a branch that had already been
submitted once. The retry fails with a 500 instead of pushing, which is the
case the retry logic exists for. It recovers only once the editor changes
something again (the commit path skips the check).

## Fix

Add `--verify` to the three calls (or drop `--end-of-options` for the constant
`FETCH_HEAD`), and add a test to `services.submit-branch.test.ts` for the
pushed-then-ahead-with-clean-tree retry. The existing retry test covers only a
never-pushed branch, where the fetch fails and the method returns early.
