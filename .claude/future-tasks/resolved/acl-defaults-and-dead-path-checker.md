# Scaffolded ACL default vs. schema default, and a dead path checker that answers "allow"

## Status: RESOLVED 2026-08-14 — decided and implemented

Split out of [baseline-2026-08-production-and-followups.md](baseline-2026-08-production-and-followups.md)
(findings B4 and B8) on 2026-08-13. Both halves are now fixed on
`fix/acl-defaults-and-creator-grant` (off `integration-202608-b`), together with
[client-server-workflow-permission-divergence.md](client-server-workflow-permission-divergence.md),
which was its stated prerequisite.

## The decision (JP, 2026-08-14)

1. `canopycms init` scaffolds `defaultBranchAccess: 'deny'`, matching the schema.
2. Creator-ownership is honored **in `checkBranchAccessWithDefault`**, so guards,
   content access and workflow actions all agree — not only in
   `canPerformWorkflowAction`.
3. The protected base branch **always passes the branch-access layer**, anonymous
   users included; the path layer alone decides what is readable.
4. `services.checkPathAccess` is deleted.
5. Both live sites migrate, path layer first (tracked separately — see below).

## What verification found that the original write-up did not

Re-verified at `4a8992fe`. Both findings were real, but the fix was bigger than
"flip the template", in two ways that had to be fixed *first*:

**The blast radius under `'deny'` was much larger than an enabled-button-then-403.**
`createContentAccessChecker` ANDs branch access into every content check, and
`runBranchAccessGuard` gates comments/schema/references. Since the create form
sends no ACL, a non-admin creating a branch got one that appeared in the branch
list and permitted **no reads, no writes, no comments** — inert, not merely
un-submittable.

**The protected base branch had no escape hatch at all.** It takes no ACL by
design (`updateBranchAccessHandler` rejects one, because an entry there feeds
`allowed_by_acl` and would confer Withdraw rights on it) and its `createdBy` is
`canopycms-system`, so nobody is its creator. Under `'deny'` the branch every
user lands on was unreachable for every non-admin, unconfigurable. The creator
grant does not help — there is no ACL to write.

**The scaffolded `'allow'` was never what made the first run frictionless.** The
template did not set `defaultPathAccess` at all, so generated projects were
already fail-closed on the path layer; `canopycms-auth-dev` auto-sets
`CANOPY_BOOTSTRAP_ADMIN_IDS`, and admins bypass both layers. `'allow'` only ever
took effect for non-admin editors — exactly the case it should not have covered.
So the flip cost roughly nothing in first-run friction.

## What shipped

`checkBranchAccessWithDefault` gained two grants, both **scoped to branches with
no ACL** so that an explicit ACL still restricts — including against a branch's
own creator, which is how an admin locks down a branch someone else created:

- the creator of an un-ACL'd branch (`reason: 'creator'`)
- the protected base branch, anonymous included (`reason: 'base_branch'`)

The base-branch grant is a fallback applied where the bare default would
otherwise decide, deliberately **not** a short-circuit ahead of the ACL: an
earlier draft short-circuited and was caught by
`role-permissions.test.ts` — it replaced `allowed_by_acl` with `base_branch` and
silently stripped Withdraw rights from ACL-listed users on a protected branch.

`createCheckBranchAccess` now takes `config` and resolves protection through
`getBranchProtection`, the existing single source of truth, rather than
re-deriving the base-branch test.

Template and all three in-repo apps flipped to `'deny'`; the template now also
states `defaultPathAccess` explicitly, since leaving it invisible is half of why
this went unnoticed. `dual-build-fixture` deliberately pairs `'deny'` with
`defaultPathAccess: { read: 'allow' }` and is the end-to-end regression test for
the base-branch grant (its anonymous `/` read must return 200).

`services.checkPathAccess` deleted from the type, the binding and the export,
along with its shape-blessing assertion and four now-dead mocks.

## Bonus outcome

Public read on a `deployedAs: 'server'` site no longer requires
`defaultBranchAccess: 'allow'`. The recipe is now `'deny'` +
`defaultPathAccess: { read: 'allow' }`, which serves published content **without**
exposing un-ACL'd work branches to other signed-in users. README's "not
read-scoped" caveat was deleted rather than reworded — the tradeoff is gone, not
restated.

## Still open

- **Live-site migration** — `docs-site-proto` and `website` both still run
  `defaultBranchAccess: 'allow'` **and** unscoped `defaultPathAccess: 'allow'`
  (read *and* edit *and* review). That is the larger exposure and it lives in
  those repos, not this one. Tracked in
  [live-site-acl-migration.md](../live-site-acl-migration.md).

## Related

- [client-server-workflow-permission-divergence.md](client-server-workflow-permission-divergence.md)
  — resolved in the server's favor by the same change
- [authorization-enforcement-consolidation.md](../authorization-enforcement-consolidation.md)
  — the matcher divergence and enforcement gaps split out of the same review
- [branch-namespace-validation-gaps.md](../branch-namespace-validation-gaps.md) —
  B2's settings-branch shadow clone was reachable partly *because* of the
  scaffolded `'allow'`
