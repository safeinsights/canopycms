# A branch name clears validation, then becomes something it should never have become

## Priority: P2

Split out of [baseline-2026-08-production-and-followups.md](resolved/baseline-2026-08-production-and-followups.md)
(findings B2 and B3) on 2026-08-13. Both re-verified still open at `78e4ca8b`.

Two places where the branch-name validation layer disagrees with what actually
lands on disk.

## B2 — the settings branch is reachable through the generic `/:branch` routes

`http/handler.ts:79`'s `shouldAutoCreate` includes `branch === settingsBranch`.
So any authenticated request to any `/:branch/…` route provisions a **content**
workspace under the deployment's settings-branch name — bypassing
`createBranchHandler`'s explicit rejection of that namespace at
`api/branch.ts:258`.

Because the resulting shadow clone is `canopycms-system`-created and
unprotected, `authorization/branch.ts:104-108`'s `isSystemBranch &&
accessResult.allowed` arm makes it **submittable by anyone with branch access** —
which, under a scaffolded `defaultBranchAccess: 'allow'`, is every authenticated
user. Outside the pre-first-push window the submit merely 409s, but the clone
exists and shows up in admin listings.

**Fix:** drop `branch === settingsBranch` from `shouldAutoCreate` (settings has
its own path via `getSettingsBranchRoot`), and/or refuse
`RESERVED_SETTINGS_BRANCH_PREFIX` in the workflow guards.

## B3 — `parseBranchName` accepts names that sanitize to a leading hyphen

`paths/validation.ts:306` rejects a *raw* leading `-`, but permits `!`, `$`, `%`,
`&`, backtick and all non-ASCII. `sanitizeBranchName` (`paths/branch-name.ts:21`)
maps those to `-`. So `!f` is accepted and becomes the git branch and directory
name `-f` — breaking the invariant `parseBranchName`'s own comment asserts, and
which `git-manager`'s separator-free `checkout` calls are documented as relying
on.

It fails safe today (500 plus an orphan directory). The hazard is that future
call sites are told they may trust it.

**Fix:** reject any name whose `sanitizeBranchName()` output starts with `-`,
guarded by a property test over the character classes above.

## Related but distinct

- [sanitized-branch-name-git-mismatch.md](sanitized-branch-name-git-mismatch.md)
  and [branch-metadata-name-sanitized-vs-raw.md](branch-metadata-name-sanitized-vs-raw.md)
  cover sanitized-vs-raw **round-tripping** — a different invariant from this one.
- [acl-defaults-and-dead-path-checker.md](resolved/acl-defaults-and-dead-path-checker.md)
  — B2's escalation path runs through the scaffolded `'allow'` default.
- `resolved/reserved-branch-route-names.md` — closed the sibling case where a
  branch name collided with a static top-level API namespace.
