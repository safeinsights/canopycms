# Migrate docs-site-proto and website off `defaultPathAccess: 'allow'`

## Priority: P1 — before either site goes live with real editors

Split out of [acl-defaults-and-dead-path-checker.md](resolved/acl-defaults-and-dead-path-checker.md)
on 2026-08-14, when the package-side half was decided and shipped. The package
now supports the target posture; these two repos have not adopted it.

Decision recorded by JP on 2026-08-14: **both sites migrate, path layer first.**

## The exposure

Both adopter sites currently set:

```typescript
defaultBranchAccess: 'allow',
defaultPathAccess: 'allow',   // unscoped -- read AND edit AND review
```

- `docs-site-proto/canopycms.config.ts:8-9`
- `website/canopycms.config.ts:6-7`

Unscoped `'allow'` on the path layer is the bigger of the two by a wide margin:
with no `permissions.json` rules, **every authenticated user can edit every path
on every branch.** `defaultBranchAccess: 'allow'` then adds that un-ACL'd work
branches are visible to all signed-in users too.

This was the actual go-live posture as of 2026-08-14, and it was not recorded
anywhere before this file.

## Target

```typescript
defaultBranchAccess: 'deny',            // work branches private; base branch exempt
defaultPathAccess: { read: 'allow' },   // edit/review fail closed
```

This is now a supported posture rather than a tradeoff: the protected base
branch passes the branch layer on its own, so public/authenticated reads of
published content keep working under `'deny'` without exposing work branches.
See README's "Public read on server deployments".

## Hard prerequisite: both sites must upgrade first

`docs-site-proto` pins `canopycms ^0.0.54`, `website` pins `^0.0.41`. The creator
and base-branch grants that make `'deny'` usable are **not in either** — they are
unreleased, on `fix/acl-defaults-and-creator-grant` off `integration-202608-b`.

Flipping to `'deny'` on the pinned versions reproduces exactly the bug that was
just fixed: the base branch unreachable for every non-admin, and every branch an
editor creates inert for its own creator. **Do not flip either site before it is
on a release containing the fix.** The path-layer change (step 2 below) is safe
on the current pins; the branch-layer change is not.

## The part that is real work

`{ read: 'allow' }` leaves `edit` at `'deny'`, and **with no path rules a
non-admin editor can create a branch but edit nothing.** Each site needs an
`edit` rule for its editors group before the flip lands, or its editors are
locked out on day one.

Note this is **not** a file to commit to the site repo. Both operating modes use
a separate settings branch (`usesSeparateSettingsBranch()` is true for prod and
dev), so `permissions.json` lives in the settings workspace, not the content
repo — which is why neither site has one checked in. It is configured by an
admin through the editor's **Permission Manager** UI
(`editor/permission-manager/`, backed by `GET`/`PUT /permissions`), which writes
to the settings branch.

So the order per site is:

1. Upgrade to a release containing the grants (see above).
2. As an admin, add an `edit` rule for the editors group in the Permission
   Manager, plus any per-tree restrictions actually wanted.
3. Flip `defaultPathAccess` to `{ read: 'allow' }`.
4. Flip `defaultBranchAccess` to `'deny'`.
5. Verify as a **non-admin** user, not just as a bootstrap admin — the admin
   bypass hides every path-layer mistake. Check: base branch content loads,
   creating a branch works, editing on it works, Submit works.

Do `docs-site-proto` first (it goes live first), then `website`.

## Why it did not land with the package change

Both are separate repos; the package work lives on
`fix/acl-defaults-and-creator-grant` off `integration-202608-b`. Nothing here
blocks that branch — the package default and both sites' explicit config are
independent.

## Related

- [acl-defaults-and-dead-path-checker.md](resolved/acl-defaults-and-dead-path-checker.md)
  — the package-side decision and implementation
- [authorization-enforcement-consolidation.md](authorization-enforcement-consolidation.md)
  — matcher divergence and enforcement gaps worth settling before relying
  heavily on path rules
