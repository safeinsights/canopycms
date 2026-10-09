# The account-id guard's remaining gaps: push-time scan and matcher blind spots

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

## Proposal: a push-time scan

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

## Known blind spots

None occurs in the tree today; each passes the check silently.

- A backslash hex escape touching the id (`\x3A<id>`), the same shape as `%3A<id>`, which the
  matcher handles by URL-decoding.
- The dashed form directly after a hyphen (`stack-dddd-dddd-dddd`). The hyphen exclusion that
  keeps card-like 4-4-4-4 numbers and UUID groups out also drops this.
- UTF-16 text files, which hold NUL bytes and are skipped as binary.
- The UUID-tail exemption matches by shape alone, so an id written after
  `xxxxxxxx-xxxx-xxxx-xxxx-` is exempt.
- An escape that decodes to a letter or digit next to the id (`%41<id>`, `%3A<id>%39`):
  decoding glues the two together. URL encoders never encode letters or digits.
- An unreadable tracked file (EACCES, ELOOP) makes `lstatSync`/`readFileSync` throw, and
  Node's error prints the absolute path unmasked. Catch it and report the masked path instead.
