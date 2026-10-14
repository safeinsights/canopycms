---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-14, measured by review, pre-existing. Six entry and content routes carry the `schema` guard but not `branchAccess`, so a user the branch layer refuses gets the branch's collection list (`GET /:branch/entries` answers 200), entry existence, and collection existence before the per-entry check refuses them. Put a branch-access guard in front of them
---

# Entry and content routes answer before the branch-access check

## Priority: P3 [BOTH]

Found 2026-10-14 by the security review of the lockdown-over-ACL fix, measured with a scratch
probe in `__integration__/permissions/role-permissions.test.ts`. Not specific to the lockdown:
any user the branch layer refuses gets the same answers.

## The gap

These endpoints use `guards: ['schema']` (plus `writableBranch` for the writes), not
`branchAccessWithSchema`, and leave access to `checkContentAccess` inside the handler:

- `api/entries.ts`: `listEntries`, delete entry
- `api/content.ts`: read, write, rename, validate references

What a refused user learns:

- `GET /:branch/entries` returns 200 with an empty `entries` list and the branch's full
  `collectionAccess` list, so the collection layout is enumerable.
- Delete answers 404 "Entry not found", or 400, before its edit check, so entry existence leaks.
- Read, write, rename and validate answer 400 on path resolution before `checkContentAccess`, so
  collection existence leaks.
- `writableBranch` reports the branch's status before any access check.

`GET /:branch/schema` and the comment routes already refuse the same user with 403.

## Fix sketch

Switch the six endpoints to `branchAccessWithSchema` (writes: plus `writableBranch`, after it).
The protected-base-branch grant keeps the base branch reachable under `defaultBranchAccess:
'deny'`. Then add `/entries` and a delete to the lockdown case in `role-permissions.test.ts`.

## Related

- [active-branch-read-resolves-schema-before-access.md](active-branch-read-resolves-schema-before-access.md):
  the same oracle in `content-reader.ts`'s `readDocument`
