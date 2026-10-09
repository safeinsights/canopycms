# `validateEntry` receives the request's `entryType`, not the resolved one

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
