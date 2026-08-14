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

## The part that is real work

`{ read: 'allow' }` leaves `edit` at `'deny'`, and **with no path rules a
non-admin editor can create a branch but edit nothing.** Each site needs a
`permissions.json` granting `edit` to its editors group before the flip lands,
or its editors are locked out on day one.

So the order per site is:

1. Write and commit `permissions.json` with an `edit` rule for the editors group
   (and any per-tree restrictions actually wanted).
2. Flip `defaultPathAccess` to `{ read: 'allow' }`.
3. Flip `defaultBranchAccess` to `'deny'`.
4. Verify as a **non-admin** user, not just as a bootstrap admin — the admin
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
