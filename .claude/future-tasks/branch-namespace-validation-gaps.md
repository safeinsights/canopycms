# `parseBranchName` accepts names that sanitize to a leading hyphen

## Priority: P3 [BOTH]

The settings-branch half (finding B2: the settings branch reachable through the generic `/:branch`
routes) is resolved in
[settings-branch-as-content-workspace.md](resolved/settings-branch-as-content-workspace.md).

`parseBranchName` (`paths/validation.ts`, line 179) rejects a *raw* leading `-`, but permits `!`,
`$`, `%`, `&`, backtick and all non-ASCII. `sanitizeBranchName` (`paths/branch-name.ts`, line 15) maps
those to `-`. So `!f` is accepted and becomes the git branch and directory name `-f`, which breaks
the invariant `parseBranchName`'s own comment asserts and which `git-manager`'s separator-free
`checkout` calls rely on.

It fails safe today (500 plus an orphan directory). The hazard is that future call sites are told they
may trust it.

**Fix:** reject any name whose `sanitizeBranchName()` output starts with `-`, guarded by a property
test over the character classes above.

## Related but distinct

- [sanitized-branch-name-git-mismatch.md](sanitized-branch-name-git-mismatch.md) and
  [branch-metadata-name-sanitized-vs-raw.md](branch-metadata-name-sanitized-vs-raw.md) cover
  sanitized-vs-raw **round-tripping**, a different invariant from this one.
- `resolved/reserved-branch-route-names.md` closed the sibling case where a branch name collided with
  a static top-level API namespace.
