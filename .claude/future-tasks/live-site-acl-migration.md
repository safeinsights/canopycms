# Migrating a live site off permissive ACL defaults

## Priority: P1 — before any site goes live with real editors

Split out of [acl-defaults-and-dead-path-checker.md](resolved/acl-defaults-and-dead-path-checker.md)
on 2026-08-14, when the package-side half was decided and shipped. The package now
supports the fail-closed posture; this file is the adopter-side sequencing, which is
more delicate than it looks.

Per-adopter specifics — which sites, their current settings, and the order they migrate
— are deliberately **not** recorded here. This repo is public; that belongs in each
adopter's own repo.

## The posture being migrated away from

A project scaffolded before the fix, or one that opted out deliberately, may carry:

```typescript
defaultBranchAccess: 'allow',
defaultPathAccess: 'allow',   // unscoped — read AND edit AND review
```

Unscoped `'allow'` on the path layer is the bigger of the two by a wide margin: with no
`permissions.json` rules, every authenticated user can edit every path on every branch.
`defaultBranchAccess: 'allow'` then adds that un-ACL'd work branches are visible to all
signed-in users too.

## Target

```typescript
defaultBranchAccess: 'deny',            // work branches private; base branch exempt
defaultPathAccess: { read: 'allow' },   // edit/review fail closed
```

This is now a supported posture rather than a tradeoff: the protected base branch passes
the branch layer on its own, so public or authenticated reads of published content keep
working under `'deny'` without exposing work branches. See README's "Public read on
server deployments".

## Hard prerequisite: upgrade before flipping

The creator grant and base-branch grant that make `'deny'` usable shipped with the
package-side fix. **Flipping to `'deny'` on a release that predates them reproduces
exactly the bug that fix closed**: the base branch unreachable for every non-admin, and
every branch an editor creates inert for its own creator.

Do not flip the branch layer before the site is on a release containing the fix. The
path-layer change is safe on older pins; the branch-layer change is not.

## The part that is real work

`{ read: 'allow' }` leaves `edit` at `'deny'`, and **with no path rules a non-admin
editor can create a branch but edit nothing.** A site needs an `edit` rule for its
editors group before the flip lands, or its editors are locked out on day one.

Note this is **not** a file to commit to the site repo. Both operating modes use a
separate settings branch (`usesSeparateSettingsBranch()` is true for prod and dev), so
`permissions.json` lives in the settings workspace rather than the content repo — which
is why a site will not have one checked in. It is configured by an admin through the
editor's **Permission Manager** UI (`editor/permission-manager/`, backed by
`GET`/`PUT /permissions`), which writes to the settings branch.

## Order, per site

1. Upgrade to a release containing the grants.
2. As an admin, add an `edit` rule for the editors group in the Permission Manager,
   plus any per-tree restrictions actually wanted.
3. Flip `defaultPathAccess` to `{ read: 'allow' }`.
4. Flip `defaultBranchAccess` to `'deny'`.
5. Verify as a **non-admin** user, not just as a bootstrap admin — the admin bypass
   hides every path-layer mistake. Check that base-branch content loads, creating a
   branch works, editing on it works, and Submit works.

Step 5 is the one most likely to be skipped and the one that catches the real failures.

## Why this did not land with the package change

The package default and a given site's explicit config are independent: a site that
sets the values explicitly is unaffected by what the scaffold generates, so nothing
here blocks the package work.

## Related

- [acl-defaults-and-dead-path-checker.md](resolved/acl-defaults-and-dead-path-checker.md)
  — the package-side decision and implementation
- [authorization-enforcement-consolidation.md](authorization-enforcement-consolidation.md)
  — matcher divergence and enforcement gaps worth settling before relying heavily on
  path rules
