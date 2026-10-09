---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-05, measured by review, pre-existing. `read` loads the active branch's schema before checking access, so a user denied on that branch can tell existing collections (`FORBIDDEN`) from missing ones (`NO_SCHEMA_ITEM`). Other branches are already checked first
---
# `read` resolves the active branch's schema before its access check

## Priority: P3 [BOTH]

Found 2026-10-05 by review of the fix for
[context-read-provisions-requested-branch.md](resolved/context-read-provisions-requested-branch.md).
Measured by the reviewer with a scratch test; pre-existing.

## The gap

`createContentReader`'s `readDocument` (`content-reader.ts`) loads the branch
schema and resolves the entry path (`resolveStore`, `resolveDocumentPath`)
before `checkContentAccess` runs. For a branch other than the active one the
request-scoped context now checks branch access first (`resolveBranch` in
`context.ts`), so this order matters only for the active branch.

A user without branch access to the active branch, typically when the active
branch is not the base branch, gets `FORBIDDEN` for a collection that exists and
`NO_SCHEMA_ITEM` for one that does not. That is a collection-existence oracle on
the active branch. Slug existence does not leak: a missing slug is also
`FORBIDDEN`.

## Fix sketch

Check branch access in `readDocument` right after resolving the branch context
and before `resolveStore`'s schema load, keeping the dev-mode reason detail the
current FORBIDDEN message carries.
