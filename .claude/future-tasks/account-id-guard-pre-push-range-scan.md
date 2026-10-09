# The account-id guard runs only at commit time and in CI

**Status:** Open. **Priority: P3.** Filed 2026-10-08 while reviewing
[public-repo-account-id-and-adopter-names.md](resolved/public-repo-account-id-and-adopter-names.md).

## State

`pnpm lint:account-ids` (`scripts/check-account-ids.mjs`) runs in pre-commit through
lint-staged and in CI. Merge commits (including hand-resolved int merges), rebased or
cherry-picked commits and `--no-verify` commits never reach pre-commit, so for them the first
check is CI. By then the branch is pushed, and this repository is public.

A pre-push line that ran the same working-tree scan was tried and dropped. It inspected
the checked-out tree, not what was being pushed: `git push origin other-branch`, or an id
committed and then deleted in an uncommitted edit, passed it.

## Proposal

Give the script a push mode for `.husky/pre-push`:

- Read the `<local-ref> <local-sha> <remote-ref> <remote-sha>` lines from stdin, and skip
  deletions.
- Scan the added lines of `git log -p -U0 --diff-merges=first-parent <local-sha> --not
  --remotes` (or `<remote-sha>..<local-sha>` when the remote sha exists), file headers
  included. That covers every commit being published, so an id added and then removed
  inside the pushed range is still caught.
- Pin it in `--self-test` with a throwaway repository.

Note that husky in a worktree resolves `core.hooksPath` to the main checkout's `.husky/_`, and
runs the hook body from the main checkout's branch, so a hook change only fires in a worktree
once the main checkout has it.
