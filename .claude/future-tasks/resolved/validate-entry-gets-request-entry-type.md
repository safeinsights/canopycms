---
priority: P1
adopters: BOTH
summary: >-
  RESOLVED 2026-10-09, branch `fix/validate-entry-resolved-type`, base `int-202610-b` (marketing-site request 70). `validateEntry` now receives the resolved entry type the store writes with (an existing entry's on-disk type, else the requested one, else the collection's default), so a save that omits `entryType` still meets a type-gated rule. The handler is the hook's only caller; renames and deletes never invoke it. A write to an `unavailable` type is still refused with `SchemaUnavailableError` before the hook runs, now pinned by a test.
---
# `validateEntry` receives the request's `entryType`, not the resolved one

**Status: RESOLVED 2026-10-09**, branch `fix/validate-entry-resolved-type`, base `int-202610-b`.

**Priority:** P1 [BOTH]. **Found:** 2026-10-06, marketing-site request 70; still true at `fecc04a0`.

## Problem

The content save handler resolves the entry type (`entryTypeName`, `api/content.ts`) and passes it
to `store.write`, but calls the adopter's `validateEntry` hook with
`...(params.entryType ? { entryType: params.entryType } : {})`: the raw request value. A save that
omits `entryType`, such as a hand-made API call, reaches the hook with no type, so a hook that gates
on the type skips its rule. The marketing site's hook refuses executable MDX in two entry types and
closes the gap by also matching path prefixes, a second rule every adopter would have to know to
write.

## Proposal

Pass the resolved `entryTypeName` to `validateEntry`, and document that the hook's `entryType` is
always the resolved type. Test: a save with `entryType` omitted calls the hook with the resolved
type.
