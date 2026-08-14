# Five diverging ACL matchers, and three places enforcement is narrower than the model

## Priority: P2

Split out of [baseline-2026-08-production-and-followups.md](resolved/baseline-2026-08-production-and-followups.md)
(finding B5, plus the B7 sub-items 12, 13 and 14 that share its theme) on
2026-08-13. All re-verified at `78e4ca8b`.

The theme: authorization is enforced inconsistently, or more narrowly than the
permission model promises.

## The matchers — five, not four

Five separate implementations answer "does this user match `allowedUsers` /
`allowedGroups`":

1. `authorization/path.ts:49`
2. `authorization/branch.ts:39`
3. `api/branch.ts:157`
4. `api/branch.ts:535`
5. `editor/components/EditorHeader.tsx:553-554` — **client-side**

The original finding counted four and missed the client one. That matters for
the fix, not just the tally: **a shared matcher has to be importable from the
browser bundle**, so it cannot reach a `node:` built-in or `pnpm lint:bundle`
fails. Put it somewhere dependency-free (the `paths/branch-name.ts` precedent) or
accept that the client keeps its own copy behind a shared test fixture.

They **already disagree**. The branch-listing filter at `api/branch.ts:518-545`
ignores `managerOrAdminAllowed`, so a branch can be hidden from listing while its
access check applies different semantics. Divergence here is a future
authorization bug, not untidiness — the fix is one shared target-matcher so
listing and enforcement cannot drift apart again.

## Three enforcement gaps in the same surface

**Comment threads leak past path ACLs** (`api/comments.ts:52-63`). `listThreads`
returns every thread on the branch, scoped by branch only. Branch access
therefore discloses comment content on entries the user cannot read by path.
*Rated P2 here rather than left in the P3 grab bag*: it is harmless only because
nobody uses path ACLs yet. The moment website v2 has editors scoped to path
subtrees, it is a real disclosure.

**`renameEntry` checks the source path only** (`api/content.ts:657`). One
`checkContentAccess` call, against the current path — nothing checks `edit` on
the destination, so a rename can move an entry into a subtree the user has no
write access to.

**Clerk `authorizedParties` stays optional in prod**
(`canopycms-auth-clerk/src/clerk-plugin.ts:137-146`). No production requirement,
so a deployment can run without the check that binds tokens to expected origins.

## Acceptance

- One shared target-matcher, browser-safe, used by all five sites (or four plus a
  shared-fixture-tested client copy).
- A test proving listing and access agree on a `managerOrAdminAllowed` branch.
- `listThreads` filters by path permission; `renameEntry` checks source **and**
  destination; Clerk config requires `authorizedParties` in prod mode.

## Related

- [acl-defaults-and-dead-path-checker.md](acl-defaults-and-dead-path-checker.md)
  — the scaffolded `'allow'` default is what keeps these latent today
- [list-permission-level.md](list-permission-level.md) — a new "list" level would
  add a sixth matcher unless this lands first
